defmodule TokenTracker.Repo.Migrations.AddAgentToUsageEvents do
  use Ecto.Migration

  def change do
    alter table(:usage_events) do
      add(:agent, :string, null: false, default: "codex")
    end

    create(index(:usage_events, [:agent]))
  end
end
