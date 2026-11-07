import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite executes business constraints. Only the D1 transport is adapted.
class Statement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sqlite, this.sql, values); }
  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.values) ?? null;
    return column ? row?.[column] ?? null : row;
  }
  async all() { return { success: true, results: this.sqlite.prepare(this.sql).all(...this.values), meta: {} }; }
  execute() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

export function createLabDatabase(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.some(table => !table.name.startsWith('lab_'))) throw new Error('Refusing to initialize a database containing non-lab tables.');
    if (tables.length) {
      const marker = sqlite.prepare("SELECT value FROM lab_meta WHERE key = 'stage'").get();
      if (marker?.value !== 'sandbox') throw new Error('Existing database is not an AI lab sandbox.');
    } else {
      const migration = readFileSync(new URL('../migrations/0001_lab.sql', import.meta.url), 'utf8');
      sqlite.exec('BEGIN IMMEDIATE');
      try { sqlite.exec(migration); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  } catch (error) { sqlite.close(); throw error; }
  const binding = {
    prepare(sql) { return new Statement(sqlite, sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { binding, sqlite, close: () => sqlite.close() };
}
