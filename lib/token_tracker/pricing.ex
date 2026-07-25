defmodule TokenTracker.Pricing do
  @moduledoc """
  Resolves current per-million-token prices from the models.dev catalog.

  The full catalog is cached on disk for 24 hours. A model absent from a fresh
  cache forces one conditional refresh, then remains marked missing until the
  cache expires so an unpublished model cannot trigger a request on every run.
  """

  alias TokenTracker.Paths

  @catalog_url "https://models.dev/api.json"
  @cache_version 1
  @ttl_seconds 86_400
  @openai_unknown_fallback "gpt-5.6-sol"

  def load(models, opts \\ []) do
    path = Keyword.get(opts, :path, Paths.pricing_cache())
    now = Keyword.get(opts, :now, DateTime.utc_now())
    fetcher = Keyword.get(opts, :fetcher, &fetch_catalog/1)
    cached = read_cache(path)

    {cache, request} = ensure_fresh(cached, now, fetcher)
    resolution = resolve_models(cache, models)

    {cache, request, resolution} =
      maybe_refresh_missing(cache, request, resolution, models, now, fetcher)

    if cache && request.successful? do
      cache
      |> Map.put("missing_models", resolution.missing_models)
      |> write_cache(path)
    end

    resolution = apply_fallbacks(cache, resolution, models)

    %{
      rates: resolution.rates,
      missing_models: resolution.missing_models,
      cache_path: path,
      fetched_at: cache && cache["fetched_at"],
      source: request.source,
      warning: request.warning
    }
  end

  def resolve(catalog, model, provider_hint \\ "openai") do
    {provider, model_id} = split_model(model, provider_hint)

    case provider_match(catalog, provider_hint, model) do
      {:ok, rates} ->
        {:ok, rates}

      :error ->
        case provider_match(catalog, provider, model_id) do
          {:ok, rates} -> {:ok, rates}
          :error -> unique_catalog_match(catalog, model)
        end
    end
  end

  def estimate(counters, rates) do
    selected = rates_for_counters(counters, rates)
    estimate_with_rates(counters, selected)
  end

  def estimate(counters, rates, pricing_tier) do
    selected =
      case pricing_tier do
        "standard" -> rates
        "tokens:" <> size -> rates_for_stored_context(rates, size)
        "context:" <> size -> context_rates(rates, size) || rates
        _ -> rates_for_counters(counters, rates)
      end

    estimate_with_rates(counters, selected)
  end

  def tier(counters, rates) do
    case rates_for_counters(counters, rates) do
      %{context_size: size} -> "context:#{size}"
      _rates -> "standard"
    end
  end

  def context_key(counters) do
    context_tokens =
      counters.input_tokens + counters.cache_read_tokens + counters.cache_write_tokens

    "tokens:#{context_tokens}"
  end

  def ttl_seconds, do: @ttl_seconds

  defp ensure_fresh(nil, now, fetcher) do
    refresh(nil, now, fetcher)
  end

  defp ensure_fresh(cache, now, fetcher) do
    if fresh?(cache, now) do
      {cache, request(:cache)}
    else
      refresh(cache, now, fetcher)
    end
  end

  defp maybe_refresh_missing(cache, request, resolution, models, now, fetcher) do
    checked_missing = MapSet.new((cache && cache["missing_models"]) || [])
    newly_missing = Enum.reject(resolution.missing_models, &MapSet.member?(checked_missing, &1))

    cond do
      cache == nil or newly_missing == [] or request.attempted? ->
        {cache, request, resolution}

      true ->
        {refreshed_cache, refreshed_request} = refresh(cache, now, fetcher)
        refreshed_resolution = resolve_models(refreshed_cache, models)
        {refreshed_cache, refreshed_request, refreshed_resolution}
    end
  end

  defp refresh(cache, now, fetcher) do
    etag = cache && cache["etag"]

    case fetcher.(etag) do
      {:ok, %{status: 200, catalog: catalog} = response} when is_map(catalog) ->
        refreshed = %{
          "version" => @cache_version,
          "fetched_at" => DateTime.to_iso8601(now),
          "etag" => response[:etag],
          "missing_models" => [],
          "catalog" => catalog
        }

        {refreshed, request(:downloaded, attempted?: true, successful?: true)}

      {:ok, %{status: 304}} when not is_nil(cache) ->
        validated =
          cache
          |> Map.put("fetched_at", DateTime.to_iso8601(now))
          |> Map.put("missing_models", [])

        {validated, request(:validated, attempted?: true, successful?: true)}

      {:error, reason} ->
        warning = "models.dev refresh failed: #{Exception.message(reason)}"
        {cache, request(failure_source(cache), attempted?: true, warning: warning)}

      other ->
        warning = "models.dev refresh returned an invalid response: #{inspect(other)}"
        {cache, request(failure_source(cache), attempted?: true, warning: warning)}
    end
  rescue
    error ->
      warning = "models.dev refresh failed: #{Exception.message(error)}"
      {cache, request(failure_source(cache), attempted?: true, warning: warning)}
  end

  defp fetch_catalog(etag) do
    headers = if etag, do: [{"if-none-match", etag}], else: []

    case Req.get(@catalog_url,
           headers: headers,
           retry: false,
           connect_options: [timeout: 10_000],
           receive_timeout: 60_000
         ) do
      {:ok, %Req.Response{status: 200, body: body} = response} ->
        with {:ok, catalog} <- decode_catalog(body) do
          {:ok,
           %{
             status: 200,
             etag: Req.Response.get_header(response, "etag") |> List.first(),
             catalog: catalog
           }}
        end

      {:ok, %Req.Response{status: 304}} ->
        {:ok, %{status: 304}}

      {:ok, %Req.Response{status: status}} ->
        {:error, RuntimeError.exception("models.dev returned HTTP #{status}")}

      {:error, error} ->
        {:error, error}
    end
  end

  defp decode_catalog(body) when is_map(body), do: {:ok, body}
  defp decode_catalog(body) when is_binary(body), do: Jason.decode(body)

  defp decode_catalog(_body) do
    {:error, RuntimeError.exception("models.dev returned an invalid JSON catalog")}
  end

  defp resolve_models(nil, models) do
    missing_models =
      models
      |> model_specs()
      |> Enum.map(& &1.label)
      |> Enum.sort()

    %{rates: %{}, missing_models: missing_models}
  end

  defp resolve_models(cache, models) do
    catalog = cache["catalog"] || %{}

    models
    |> model_specs()
    |> Enum.reduce(%{rates: %{}, missing_models: []}, fn spec, result ->
      case resolve(catalog, spec.model, spec.provider) do
        {:ok, rates} ->
          %{result | rates: Map.put(result.rates, spec.key, rates)}

        :error ->
          %{result | missing_models: [spec.label | result.missing_models]}
      end
    end)
    |> Map.update!(:missing_models, &Enum.reverse/1)
  end

  defp apply_fallbacks(cache, resolution, models) do
    catalog = (cache && cache["catalog"]) || %{}

    rates =
      models
      |> model_specs()
      |> Enum.reduce(resolution.rates, fn spec, rates ->
        if Map.has_key?(rates, spec.key) do
          rates
        else
          Map.put(rates, spec.key, fallback_rates(catalog, spec))
        end
      end)

    %{resolution | rates: rates, missing_models: []}
  end

  defp fallback_rates(catalog, spec) do
    if openai_unknown?(spec) do
      case resolve(catalog, @openai_unknown_fallback, "openai") do
        {:ok, rates} -> rates
        :error -> zero_rates()
      end
    else
      zero_rates()
    end
  end

  defp openai_unknown?(spec) do
    case split_model(spec.model, spec.provider) do
      {"openai", "unknown"} -> true
      _ -> false
    end
  end

  defp zero_rates do
    %{
      input: 0.0,
      output: 0.0,
      reasoning: 0.0,
      cache_read: 0.0,
      cache_write: 0.0,
      tiers: []
    }
  end

  defp model_specs(models) do
    models
    |> Enum.map(&model_spec/1)
    |> Enum.uniq_by(& &1.key)
    |> Enum.sort_by(& &1.label)
  end

  defp model_spec(%{model: model} = spec) do
    provider = Map.get(spec, :provider)

    %{
      key: {provider, model},
      label: model_label(provider, model),
      model: model,
      provider: provider
    }
  end

  defp model_spec(model) do
    %{key: model, label: model, model: model, provider: "openai"}
  end

  defp model_label(nil, model), do: model

  defp model_label(provider, model) do
    if String.starts_with?(model, provider <> "/"), do: model, else: "#{provider}/#{model}"
  end

  defp split_model(model, provider_hint) do
    case String.split(model, "/", parts: 2) do
      [provider, model_id] -> {provider, model_id}
      [model_id] -> {provider_hint, model_id}
    end
  end

  defp provider_match(_catalog, nil, _model), do: :error

  defp provider_match(catalog, provider, model) do
    with %{} = provider_entry <- catalog[provider],
         %{} = candidate <- get_in(provider_entry, ["models", model]),
         {:ok, rates} <- normalize_rates(candidate["cost"]) do
      {:ok, rates}
    else
      _ -> :error
    end
  end

  defp unique_catalog_match(catalog, model) do
    matches =
      for {_provider_id, provider} <- catalog,
          {model_id, candidate} <- provider["models"] || %{},
          model_id == model or candidate["id"] == model,
          {:ok, rates} <- [normalize_rates(candidate["cost"])],
          do: rates

    case matches do
      [rates] -> {:ok, rates}
      _ -> :error
    end
  end

  defp normalize_rates(cost) when is_map(cost) do
    with {:ok, input} <- number(cost["input"]),
         {:ok, output} <- number(cost["output"]) do
      base = rates(cost, input, output)

      tiers =
        case cost["tiers"] do
          tiers when is_list(tiers) -> Enum.flat_map(tiers, &normalize_tier(&1, base))
          _ -> legacy_context_tier(cost["context_over_200k"], base)
        end

      {:ok, Map.put(base, :tiers, tiers)}
    end
  end

  defp normalize_rates(_cost), do: :error

  defp number(value) when is_integer(value), do: {:ok, value / 1}
  defp number(value) when is_float(value), do: {:ok, value}
  defp number(_value), do: :error

  defp numeric_or(value, fallback) do
    case number(value) do
      {:ok, number} -> number
      :error -> fallback
    end
  end

  defp rates(cost, input, output) do
    %{
      input: input,
      output: output,
      reasoning: numeric_or(cost["reasoning"], output),
      cache_read: numeric_or(cost["cache_read"] || cost["cacheRead"], input),
      cache_write: numeric_or(cost["cache_write"] || cost["cacheWrite"], input)
    }
  end

  defp normalize_tier(%{"tier" => %{"type" => "context", "size" => size}} = tier, _base)
       when is_number(size) do
    with {:ok, input} <- number(tier["input"]),
         {:ok, output} <- number(tier["output"]) do
      [rates(tier, input, output) |> Map.put(:context_size, trunc(size))]
    else
      _ -> []
    end
  end

  defp normalize_tier(_tier, _base), do: []

  defp legacy_context_tier(tier, _base) when not is_map(tier), do: []

  defp legacy_context_tier(tier, _base) do
    with {:ok, input} <- number(tier["input"]),
         {:ok, output} <- number(tier["output"]) do
      [rates(tier, input, output) |> Map.put(:context_size, 200_000)]
    else
      _ -> []
    end
  end

  defp rates_for_counters(counters, rates) do
    context_tokens =
      counters.input_tokens + counters.cache_read_tokens + counters.cache_write_tokens

    rates.tiers
    |> Enum.filter(&(context_tokens > &1.context_size))
    |> Enum.max_by(& &1.context_size, fn -> rates end)
  end

  defp context_rates(rates, size) do
    case Integer.parse(size) do
      {parsed, ""} -> Enum.find(rates.tiers, &(&1.context_size == parsed))
      _ -> nil
    end
  end

  defp rates_for_stored_context(rates, size) do
    case Integer.parse(size) do
      {context_tokens, ""} when context_tokens >= 0 ->
        rates_for_context_tokens(context_tokens, rates)

      _ ->
        rates
    end
  end

  defp rates_for_context_tokens(context_tokens, rates) do
    rates.tiers
    |> Enum.filter(&(context_tokens > &1.context_size))
    |> Enum.max_by(& &1.context_size, fn -> rates end)
  end

  defp estimate_with_rates(counters, selected) do
    (counters.input_tokens * selected.input +
       counters.output_tokens * selected.output +
       counters.reasoning_tokens * selected.reasoning +
       counters.cache_read_tokens * selected.cache_read +
       counters.cache_write_tokens * selected.cache_write) / 1_000_000
  end

  defp fresh?(cache, now) do
    with @cache_version <- cache["version"],
         fetched_at when is_binary(fetched_at) <- cache["fetched_at"],
         {:ok, fetched_at, _offset} <- DateTime.from_iso8601(fetched_at),
         age when age >= 0 <- DateTime.diff(now, fetched_at, :second) do
      age < @ttl_seconds
    else
      _ -> false
    end
  end

  # Decoding the multi-megabyte catalog dominated dashboard response time, so the
  # decoded term is memoized per path.
  #
  # The memo is keyed on a hash of the file's bytes rather than its metadata.
  # Erlang exposes modification times only to the second, so a stamp of
  # {mtime, size} cannot distinguish a same-second replacement by a different
  # document of equal length, and would serve the superseded catalog until the
  # file changed again. Reading and hashing costs a small fraction of decoding.
  defp read_cache(path) do
    case File.read(path) do
      {:ok, contents} ->
        stamp = :erlang.phash2(contents)

        case :persistent_term.get({__MODULE__, :cache, path}, nil) do
          %{stamp: ^stamp, cache: cache} ->
            cache

          _stale ->
            cache = decode_cache(contents)
            :persistent_term.put({__MODULE__, :cache, path}, %{stamp: stamp, cache: cache})
            cache
        end

      {:error, _reason} ->
        forget_cache(path)
        nil
    end
  end

  defp decode_cache(contents) do
    with {:ok, %{"catalog" => catalog} = cache} <- Jason.decode(contents),
         true <- is_map(catalog) do
      cache
    else
      _ -> nil
    end
  end

  defp forget_cache(path), do: :persistent_term.erase({__MODULE__, :cache, path})

  defp write_cache(cache, path) do
    File.mkdir_p!(Path.dirname(path))
    temporary = "#{path}.tmp-#{System.unique_integer([:positive, :monotonic])}"

    try do
      File.write!(temporary, Jason.encode!(cache))
      File.chmod!(temporary, 0o600)
      File.rename!(temporary, path)

      # The memoized entry is dropped rather than replaced with this writer's
      # term. Another writer may rename a different catalog over the same path
      # between this rename and any stat of it, which would publish this cache
      # under that file's stamp. Forgetting is always correct; the next read
      # repopulates from whatever is actually on disk.
      forget_cache(path)
    after
      File.rm(temporary)
    end
  end

  defp request(source, opts \\ []) do
    %{
      source: source,
      attempted?: Keyword.get(opts, :attempted?, false),
      successful?: Keyword.get(opts, :successful?, false),
      warning: Keyword.get(opts, :warning)
    }
  end

  defp failure_source(nil), do: :unavailable
  defp failure_source(_cache), do: :stale
end
