import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

// Statements are prepared when executed, matching D1's deferred batch semantics.
class Statement {
  constructor(sqlite, sql, args=[]) { this.sqlite=sqlite;this.sql=sql;this.args=args; }
  bind(...args) { return new Statement(this.sqlite,this.sql,args); }
  async first(column) {const row=this.sqlite.prepare(this.sql).get(...this.args);return column?row?.[column]??null:row??null;}
  async all() {return {success:true,results:this.sqlite.prepare(this.sql).all(...this.args),meta:{}};}
  execute() {const result=this.sqlite.prepare(this.sql).run(...this.args);return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
  async run() {return this.execute();}
}
export function createTestDatabase(filename=':memory:') {
  const sqlite=new DatabaseSync(filename);sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const hadInitial=!!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT(datetime('now')))");
  const migrations=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(migrations).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()) {
    if(sqlite.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name))continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      // Old local databases predate migration tracking but already contain 0001.
      if(!(hadInitial&&name==='0001_initial.sql'))sqlite.exec(readFileSync(new URL(name,migrations),'utf8'));
      sqlite.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(name);sqlite.exec('COMMIT');
    }catch(error){sqlite.exec('ROLLBACK');sqlite.close();throw error;}
  }
  const binding={prepare:sql=>new Statement(sqlite,sql),async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(statement=>statement.execute());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {binding,sqlite,close:()=>sqlite.close()};
}

// External authentication service double only. Business rules run on real SQLite.
export function createTestAuth() {
 const accounts=new Map();
 const error=code=>Object.assign(new Error(code),{code});
 const auth={
  async createUser({username,password}){if(accounts.has(username))throw error('USERNAME_TAKEN');const uid=crypto.randomUUID();accounts.set(username,{uid,password});return {uid};},
  async verifyPassword({username,password}){const row=accounts.get(username);if(!row||row.password!==password)throw error('INVALID_CREDENTIALS');return {uid:row.uid};},
  async setPassword({uid,password}){const row=[...accounts.values()].find(r=>r.uid===uid);if(!row)throw error('UNAVAILABLE');row.password=password;},
  async deleteUser({uid}){for(const [username,row] of accounts)if(row.uid===uid)accounts.delete(username);}
 };return {auth,accounts};
}
