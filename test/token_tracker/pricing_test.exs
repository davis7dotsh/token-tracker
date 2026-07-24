defmodule TokenTracker.PricingTest do
  use ExUnit.Case, async: true

  import Bitwise

  alias TokenTracker.Pricing

  @now ~U[2026-07-23 12:00:00.000000Z]

  test "resolves models.dev rates and prices reasoning at the output rate by default" do
    catalog =
      catalog(%{
        "gpt-priced" => %{
          "id" => "gpt-priced",
          "cost" => %{
            "input" => 5,
            "output" => 30,
            "cache_read" => 0.5,
            "cache_write" => 6.25
          }
        }
      })

    assert {:ok, rates} = Pricing.resolve(catalog, "gpt-priced")
    assert rates.reasoning == 30.0
    assert rates.tiers == []

    counters = %{
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      reasoning_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 1_000_000
    }

    assert_in_delta Pricing.estimate(counters, rates), 71.75, 0.000_001
  end

  test "uses explicit reasoning prices and input fallbacks for absent cache prices" do
    catalog =
      catalog(%{
        "gpt-priced" => %{
          "cost" => %{"input" => 2, "output" => 10, "reasoning" => 12}
        }
      })

    assert {:ok, rates} = Pricing.resolve(catalog, "gpt-priced")

    assert rates == %{
             input: 2.0,
             output: 10.0,
             reasoning: 12.0,
             cache_read: 2.0,
             cache_write: 2.0,
             tiers: []
           }
  end

  test "uses the event provider when a model name exists in multiple catalogs" do
    catalog = %{
      "anthropic" => %{
        "models" => %{
          "shared-model" => %{"cost" => %{"input" => 2, "output" => 10}}
        }
      },
      "openrouter" => %{
        "models" => %{
          "shared-model" => %{"cost" => %{"input" => 3, "output" => 12}}
        }
      }
    }

    assert {:ok, rates} = Pricing.resolve(catalog, "shared-model", "anthropic")
    assert rates.input == 2.0

    loaded =
      Pricing.load(
        [%{provider: "openrouter", model: "shared-model"}],
        path: cache_path(),
        now: @now,
        fetcher: fn _etag -> {:ok, %{status: 200, catalog: catalog}} end
      )

    assert loaded.rates[{"openrouter", "shared-model"}].input == 3.0
  end

  test "applies a context pricing tier to individual large-context events" do
    catalog =
      catalog(%{
        "gpt-tiered" => %{
          "cost" => %{
            "input" => 1,
            "output" => 2,
            "cache_read" => 0.1,
            "tiers" => [
              %{
                "input" => 2,
                "output" => 4,
                "cache_read" => 0.2,
                "tier" => %{"type" => "context", "size" => 200_000}
              }
            ]
          }
        }
      })

    assert {:ok, rates} = Pricing.resolve(catalog, "gpt-tiered")

    small = counters(input_tokens: 50_000, cache_read_tokens: 100_000)
    large = counters(input_tokens: 50_001, cache_read_tokens: 150_000)

    assert_in_delta Pricing.estimate(small, rates), 0.06, 0.000_001
    assert_in_delta Pricing.estimate(large, rates), 0.130_002, 0.000_001
  end

  test "downloads once, reuses a fresh disk cache, and validates it after 24 hours" do
    path = cache_path()
    parent = self()
    catalog = catalog(%{"gpt-priced" => %{"cost" => %{"input" => 1, "output" => 2}}})

    fetch = fn etag ->
      send(parent, {:fetch, etag})
      {:ok, %{status: 200, etag: "\"v1\"", catalog: catalog}}
    end

    first = Pricing.load(["gpt-priced"], path: path, now: @now, fetcher: fetch)
    assert first.source == :downloaded
    assert first.missing_models == []
    assert_receive {:fetch, nil}
    assert File.exists?(path)
    assert (File.stat!(path).mode &&& 0o777) == 0o600

    second =
      Pricing.load(["gpt-priced"],
        path: path,
        now: DateTime.add(@now, 60, :second),
        fetcher: fn _etag -> flunk("fresh cache unexpectedly fetched") end
      )

    assert second.source == :cache

    stale_fetch = fn etag ->
      send(parent, {:stale_fetch, etag})
      {:ok, %{status: 304}}
    end

    third =
      Pricing.load(["gpt-priced"],
        path: path,
        now: DateTime.add(@now, Pricing.ttl_seconds() + 1, :second),
        fetcher: stale_fetch
      )

    assert third.source == :validated
    assert_receive {:stale_fetch, "\"v1\""}
  end

  test "a newly missing model forces one refresh and is then remembered" do
    path = cache_path()
    parent = self()
    catalog = catalog(%{"gpt-priced" => %{"cost" => %{"input" => 1, "output" => 2}}})

    initial_fetch = fn _etag ->
      send(parent, :initial_fetch)
      {:ok, %{status: 200, etag: "\"v1\"", catalog: catalog}}
    end

    first = Pricing.load(["missing-one"], path: path, now: @now, fetcher: initial_fetch)
    assert first.missing_models == ["missing-one"]
    assert_receive :initial_fetch

    Pricing.load(["missing-one"],
      path: path,
      now: DateTime.add(@now, 60, :second),
      fetcher: fn _etag -> flunk("known missing model fetched again") end
    )

    refresh = fn etag ->
      send(parent, {:missing_refresh, etag})
      {:ok, %{status: 304}}
    end

    third =
      Pricing.load(["missing-one", "missing-two"],
        path: path,
        now: DateTime.add(@now, 120, :second),
        fetcher: refresh
      )

    assert third.source == :validated
    assert third.missing_models == ["missing-one", "missing-two"]
    assert_receive {:missing_refresh, "\"v1\""}

    Pricing.load(["missing-one", "missing-two"],
      path: path,
      now: DateTime.add(@now, 180, :second),
      fetcher: fn _etag -> flunk("remembered missing models fetched again") end
    )
  end

  test "a forced refresh can discover pricing for a newly published model" do
    path = cache_path()
    old_catalog = catalog(%{"gpt-old" => %{"cost" => %{"input" => 1, "output" => 2}}})
    new_catalog = catalog(%{"gpt-new" => %{"cost" => %{"input" => 3, "output" => 9}}})

    Pricing.load(["gpt-old"],
      path: path,
      now: @now,
      fetcher: fn _etag -> {:ok, %{status: 200, etag: "\"v1\"", catalog: old_catalog}} end
    )

    refreshed =
      Pricing.load(["gpt-new"],
        path: path,
        now: DateTime.add(@now, 60, :second),
        fetcher: fn "\"v1\"" ->
          {:ok, %{status: 200, etag: "\"v2\"", catalog: new_catalog}}
        end
      )

    assert refreshed.source == :downloaded
    assert refreshed.missing_models == []
    assert refreshed.rates["gpt-new"].input == 3.0
  end

  test "keeps a stale last-known-good catalog when refresh fails" do
    path = cache_path()
    catalog = catalog(%{"gpt-priced" => %{"cost" => %{"input" => 1, "output" => 2}}})

    Pricing.load(["gpt-priced"],
      path: path,
      now: @now,
      fetcher: fn _etag -> {:ok, %{status: 200, etag: "\"v1\"", catalog: catalog}} end
    )

    stale =
      Pricing.load(["gpt-priced"],
        path: path,
        now: DateTime.add(@now, Pricing.ttl_seconds() + 1, :second),
        fetcher: fn _etag -> {:error, RuntimeError.exception("offline")} end
      )

    assert stale.source == :stale
    assert stale.rates["gpt-priced"].output == 2.0
    assert stale.warning =~ "offline"
  end

  test "reports pricing as unavailable when the first download fails" do
    unavailable =
      Pricing.load(["gpt-priced"],
        path: cache_path(),
        now: @now,
        fetcher: fn _etag -> {:error, RuntimeError.exception("offline")} end
      )

    assert unavailable.source == :unavailable
    assert unavailable.rates == %{}
    assert unavailable.missing_models == ["gpt-priced"]
    assert unavailable.warning =~ "offline"
  end

  defp catalog(models), do: %{"openai" => %{"models" => models}}

  defp counters(overrides) do
    Map.merge(
      %{
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0
      },
      Map.new(overrides)
    )
  end

  defp cache_path do
    directory =
      Path.join(
        System.tmp_dir!(),
        "token-tracker-pricing-#{System.unique_integer([:positive, :monotonic])}"
      )

    on_exit(fn -> File.rm_rf!(directory) end)
    Path.join(directory, "pricing-cache.json")
  end
end
