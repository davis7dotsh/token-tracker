defmodule TokenTracker.Repo.Migrations.AddProviderToUsageEvents do
  use Ecto.Migration

  def change do
    alter table(:usage_events) do
      add(:provider, :string, default: "openai")
    end

    create(index(:usage_events, [:provider, :model]))
  end
end
