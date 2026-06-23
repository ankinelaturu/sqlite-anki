import { useCallback, useEffect, useState } from "react";
import {
  connectAnkiDatabase,
  disconnectAnkiDatabase,
  type AnkiDatabaseApi,
  type ColumnInfo,
  type Row,
  type TableInfo,
} from "@sqlite-anki/db-client";
import { DataGrid } from "./components/DataGrid";
import { SchemaTree } from "./components/SchemaTree";

/** Root explorer application: schema tree (left) + CRUD grid (right). */
export function App() {
  const [db, setDb] = useState<AnkiDatabaseApi | null>(null);
  const [meta, setMeta] = useState<{ opfs: boolean; version: string } | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [columnsByTable, setColumnsByTable] = useState<Record<string, ColumnInfo[]>>({});
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [dataColumns, setDataColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [semanticMode, setSemanticMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const loadSchema = useCallback(async (api: AnkiDatabaseApi) => {
    const list = await api.listTables();
    setTables(list);

    const colMap: Record<string, ColumnInfo[]> = {};
    for (const t of list) {
      colMap[t.name] = await api.getColumns(t.name);
    }
    setColumnsByTable(colMap);
    return list;
  }, []);

  const loadTableData = useCallback(
    async (api: AnkiDatabaseApi, table: string, semantic = false) => {
      setSemanticMode(semantic);
      const result = semantic
        ? null
        : await api.fetchRows(table, 500, 0);
      if (result) {
        setDataColumns(result.columns);
        setRows(result.rows);
        setStatus(`${result.rows.length} row(s)`);
      }
    },
    [],
  );

  const selectTable = useCallback(
    async (api: AnkiDatabaseApi, table: string) => {
      setSelectedTable(table);
      const cols = await api.getColumns(table);
      setColumns(cols);
      await loadTableData(api, table, false);
    },
    [loadTableData],
  );

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        setLoading(true);
        setError(null);
        const { api, opfs, version } = await connectAnkiDatabase();
        if (cancelled) return;

        setDb(api);
        setMeta({ opfs, version });

        const list = await loadSchema(api);
        if (list.length > 0) {
          await selectTable(api, list[0]!.name);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void init();

    return () => {
      cancelled = true;
      disconnectAnkiDatabase();
    };
  }, [loadSchema, selectTable]);

  const refresh = async () => {
    if (!db || !selectedTable) return;
    await loadSchema(db);
    await loadTableData(db, selectedTable, false);
  };

  const handleSeed = async () => {
    if (!db) return;
    try {
      setError(null);
      await db.seedDemo();
      const list = await loadSchema(db);
      if (list.length > 0) {
        await selectTable(db, list[0]!.name);
      }
      setStatus("Demo data ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSemanticSearch = async (
    column: string,
    query: string,
    minSimilarity: number,
  ) => {
    if (!db || !selectedTable) return;
    try {
      setError(null);
      const result = await db.semanticSearch(
        selectedTable,
        column,
        query,
        20,
        minSimilarity,
      );
      setDataColumns(result.columns);
      setRows(result.rows);
      setSemanticMode(true);
      setStatus(`Semantic search: ${result.rows.length} row(s)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>sqlite-anki Explorer</h1>
          <div className="meta">
            {meta
              ? `SQLite ${meta.version} · ${meta.opfs ? "OPFS" : "transient"}`
              : "Connecting…"}
          </div>
        </div>
        <div className="actions">
          <button type="button" onClick={() => void handleSeed()}>
            Seed demo
          </button>
          <button type="button" onClick={() => void refresh()}>
            Reload schema
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="empty-state">Loading database…</div>
      ) : (
        <div className="app-body">
          <aside className="panel panel-left">
            <div className="panel-title">Schema</div>
            <SchemaTree
              tables={tables}
              columnsByTable={columnsByTable}
              selectedTable={selectedTable}
              onSelectTable={(name) => {
                if (db) void selectTable(db, name);
              }}
            />
          </aside>

          <main className="panel panel-right">
            <div className="panel-title">Data</div>
            {selectedTable && db ? (
              <>
                <DataGrid
                  table={selectedTable}
                  columns={columns}
                  dataColumns={dataColumns}
                  rows={rows}
                  semanticMode={semanticMode}
                  onRefresh={() => void refresh()}
                  onUpdateCell={async (rowid, column, value) => {
                    await db.updateCell(selectedTable, rowid, column, value);
                    await loadTableData(db, selectedTable, false);
                  }}
                  onDeleteRow={async (rowid) => {
                    await db.deleteRow(selectedTable, rowid);
                    await loadTableData(db, selectedTable, false);
                  }}
                  onInsertRow={async (values) => {
                    await db.insertRow(selectedTable, values);
                    await loadTableData(db, selectedTable, false);
                  }}
                  onSemanticSearch={(col, q, min) =>
                    void handleSemanticSearch(col, q, min)
                  }
                />
                <div className="status-bar">{status}</div>
              </>
            ) : (
              <div className="empty-state">
                Select a table or seed demo data to begin.
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
