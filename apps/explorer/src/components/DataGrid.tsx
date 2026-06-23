import { useCallback, useState } from "react";
import type { ColumnInfo, Row } from "@sqlite-anki/db-client";

interface DataGridProps {
  table: string;
  columns: ColumnInfo[];
  dataColumns: string[];
  rows: Row[];
  onRefresh: () => void;
  onUpdateCell: (
    rowid: number,
    column: string,
    value: string | number | null,
  ) => Promise<void>;
  onDeleteRow: (rowid: number) => Promise<void>;
  onInsertRow: (values: Record<string, string | null>) => Promise<void>;
  onSemanticSearch: (column: string, query: string, minSimilarity: number) => void;
  semanticMode: boolean;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

/** Right panel: editable table grid with row delete and semantic search hook. */
export function DataGrid({
  table,
  columns,
  dataColumns,
  rows,
  onRefresh,
  onUpdateCell,
  onDeleteRow,
  onInsertRow,
  onSemanticSearch,
  semanticMode,
}: DataGridProps) {
  const [editing, setEditing] = useState<{
    rowid: number;
    column: string;
    value: string;
  } | null>(null);
  const [showNewRow, setShowNewRow] = useState(false);
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchColumn, setSearchColumn] = useState("");
  const [minSimilarity, setMinSimilarity] = useState(0.5);

  const editableColumns = columns.filter((c) => c.name !== "rowid");
  const vectorColumns = columns.filter((c) => c.isVector);

  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const { rowid, column, value } = editing;
    setEditing(null);
    await onUpdateCell(rowid, column, value === "" ? null : value);
  }, [editing, onUpdateCell]);

  const handleNewRowSubmit = async () => {
    const values: Record<string, string | null> = {};
    for (const col of editableColumns) {
      const v = newRow[col.name];
      values[col.name] = v === undefined || v === "" ? null : v;
    }
    await onInsertRow(values);
    setNewRow({});
    setShowNewRow(false);
  };

  const displayColumns = dataColumns.length > 0 ? dataColumns : ["rowid", ...editableColumns.map((c) => c.name)];

  return (
    <>
      <div className="toolbar">
        <strong>{table}</strong>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
        <button type="button" className="primary" onClick={() => setShowNewRow((v) => !v)}>
          {showNewRow ? "Cancel" : "Add row"}
        </button>

        {vectorColumns.length > 0 && (
          <div className="semantic-bar">
            <select
              value={searchColumn || vectorColumns[0]?.name || ""}
              onChange={(e) => setSearchColumn(e.target.value)}
            >
              {vectorColumns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Semantic search (MATCH)…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchQuery.trim()) {
                  onSemanticSearch(
                    searchColumn || vectorColumns[0]!.name,
                    searchQuery.trim(),
                    minSimilarity,
                  );
                }
              }}
            />
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minSimilarity}
              onChange={(e) => setMinSimilarity(Number(e.target.value))}
              title="Min similarity"
              style={{ width: "4rem" }}
            />
            <button
              type="button"
              className="primary"
              disabled={!searchQuery.trim()}
              onClick={() =>
                onSemanticSearch(
                  searchColumn || vectorColumns[0]!.name,
                  searchQuery.trim(),
                  minSimilarity,
                )
              }
            >
              Search
            </button>
          </div>
        )}
      </div>

      {semanticMode && (
        <div className="status-bar" style={{ background: "#eff6ff" }}>
          Showing semantic search results
        </div>
      )}

      {showNewRow && (
        <div className="new-row-form">
          {editableColumns.map((col) => (
            <label key={col.name}>
              {col.name}
              {col.isVector && <span className="badge-vector">vector</span>}
              <input
                value={newRow[col.name] ?? ""}
                onChange={(e) =>
                  setNewRow((prev) => ({ ...prev, [col.name]: e.target.value }))
                }
              />
            </label>
          ))}
          <button type="button" className="primary" onClick={handleNewRowSubmit}>
            Save row
          </button>
        </div>
      )}

      <div className="data-grid-wrap">
        {rows.length === 0 ? (
          <div className="empty-state">No rows in this table.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                {displayColumns.map((col) => (
                  <th key={col}>{col}</th>
                ))}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rowid = Number(row.rowid);
                return (
                  <tr key={rowid}>
                    {displayColumns.map((col) => {
                      const isEditing =
                        editing?.rowid === rowid && editing.column === col;
                      const raw = row[col];
                      const isRowid = col === "rowid";

                      return (
                        <td key={col}>
                          {isRowid ? (
                            formatCell(raw)
                          ) : isEditing ? (
                            <input
                              autoFocus
                              value={editing.value}
                              onChange={(e) =>
                                setEditing({ ...editing, value: e.target.value })
                              }
                              onBlur={() => void commitEdit()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void commitEdit();
                                if (e.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : (
                            <span
                              role="button"
                              tabIndex={0}
                              className={raw == null ? "cell-null" : undefined}
                              onDoubleClick={() =>
                                setEditing({
                                  rowid,
                                  column: col,
                                  value: formatCell(raw),
                                })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  setEditing({
                                    rowid,
                                    column: col,
                                    value: formatCell(raw),
                                  });
                                }
                              }}
                            >
                              {raw == null ? "NULL" : formatCell(raw)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void onDeleteRow(rowid)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
