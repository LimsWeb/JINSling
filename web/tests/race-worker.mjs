import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.gate),0,0);
try{db.prepare(workerData.sql).run(...workerData.args);parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({ok:false,error:e.message});}finally{db.close();}
