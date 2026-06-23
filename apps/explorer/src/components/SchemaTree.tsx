import type { ColumnInfo, TableInfo } from "@sqlite-anki/db-client";

interface SchemaTreeProps {
  tables: TableInfo[];
  columnsByTable: Record<string, ColumnInfo[]>;
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
}

/** Left panel: tree of tables and their columns. */
export function SchemaTree({
  tables,
  columnsByTable,
  selectedTable,
  onSelectTable,
}: SchemaTreeProps) {
  if (tables.length === 0) {
    return (
      <div className="empty-state">
        No tables yet. Use &quot;Seed demo&quot; to create sample data.
      </div>
    );
  }

  return (
    <div className="schema-tree">
      {tables.map((table) => {
        const columns = columnsByTable[table.name] ?? [];
        const isActive = selectedTable === table.name;

        return (
          <div key={table.name} className="tree-table">
            <button
              type="button"
              className={`tree-table-btn ${isActive ? "active" : ""}`}
              onClick={() => onSelectTable(table.name)}
            >
              {table.isVirtual ? "⚡ " : "📋 "}
              {table.name}
            </button>
            {isActive && (
              <div className="tree-columns">
                {columns.map((col) => (
                  <div key={col.name} className="tree-column">
                    {col.name}
                    <span className="tree-column-type"> ({col.type || "ANY"})</span>
                    {col.isVector && <span className="badge-vector">vector</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
