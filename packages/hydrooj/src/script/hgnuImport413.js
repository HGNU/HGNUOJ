/* eslint-disable no-await-in-loop -- Preserve ordered updates and progress checkpoints. */
// Copy this file to hydrooj/src/script/hgnuImport413.js on the Hydro 4.13.4 server.
// Run through: node hydrooj/bin/hydrooj.js cli script hgnuImport413 '{"base":"/root/hydro_export"}'
// The default is read-only. Pass apply:true only after a verified backup and dry run.
const fs = require('fs');
const path = require('path');
const schemastery = require('schemastery');
const Schema = schemastery.default?.any ? schemastery.default : schemastery;
const ProblemModel = require('../model/problem').default;
const db = require('../service/db').default;

const DOMAIN = 'system';

function plannedNew(pid) {
    const match = /^P(\d+)$/.exec(pid);
    return !!match && Number(match[1]) >= 4899 && Number(match[1]) <= 4999;
}

function readPackages(base, only) {
    const root = path.resolve(base);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (!Array.isArray(manifest)) throw new TypeError('manifest.json must be an array');
    const seen = new Set();
    const selected = [];
    for (const item of manifest) {
        if (!/^P\d+$/.test(item.pid) || seen.has(item.pid)) throw new Error(`Invalid/duplicate PID: ${item.pid}`);
        seen.add(item.pid);
        if (only && item.pid !== only) continue;
        const dir = path.resolve(root, item.dir);
        if (!dir.startsWith(root + path.sep)) throw new Error(`Unsafe path: ${item.dir}`);
        const yaml = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
        if (!yaml.includes(`pid: ${item.pid}`)) throw new Error(`PID differs in problem.yaml: ${item.pid}`);
        const statement = fs.readFileSync(path.join(dir, 'problem_zh.md'), 'utf8');
        if (!statement.trim()) throw new Error(`Empty statement: ${item.pid}`);
        const dataDir = path.join(dir, 'testdata');
        const names = fs.readdirSync(dataDir).sort();
        if (!names.includes('config.yaml')) throw new Error(`Missing config.yaml: ${item.pid}`);
        for (const name of names) {
            if (!fs.statSync(path.join(dataDir, name)).isFile()) throw new Error(`Nested testdata: ${item.pid}/${name}`);
            if (name.endsWith('.in') && !names.includes(`${name.slice(0, -3)}.out`)) {
                throw new Error(`Missing output: ${item.pid}/${name}`);
            }
        }
        const tests = names.filter((name) => name.endsWith('.in')).length;
        if (tests !== item.tests) throw new Error(`Test count differs: ${item.pid} ${tests}/${item.tests}`);
        selected.push({ item, statement, dataDir, names });
    }
    if (only && selected.length !== 1) throw new Error(`PID not in manifest: ${only}`);
    return selected;
}

async function run(arg = {}, report = console.log) {
    const base = arg.base || '/root/hydro_export';
    const only = arg.only || '';
    const operator = Number(arg.operator);
    if (arg.apply && (!Number.isSafeInteger(operator) || operator < 1)) {
        throw new Error('apply requires a positive operator UID');
    }
    const packages = readPackages(base, only);
    const progressPath = path.join(path.resolve(base), '.hgnu-import-progress.json');
    const progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf8')) : {};
    const coll = db.collection('document');
    const pids = packages.map((p) => p.item.pid);
    const existing = await coll.find(
        { domainId: DOMAIN, docType: 10, pid: { $in: pids } },
        { projection: { pid: 1, docId: 1, title: 1, data: 1 } },
    ).toArray();
    const byPid = new Map(existing.map((p) => [p.pid, p]));
    const conflicts = [];
    for (const p of packages) {
        const old = byPid.get(p.item.pid);
        if (plannedNew(p.item.pid) && old && progress[p.item.pid] !== old.docId) {
            conflicts.push(`${p.item.pid} expected new, found docId=${old.docId}`);
        }
        if (plannedNew(p.item.pid) && !old && progress[p.item.pid]) {
            conflicts.push(`${p.item.pid} missing after prior import docId=${progress[p.item.pid]}`);
        }
        if (!plannedNew(p.item.pid) && !old) conflicts.push(`${p.item.pid} expected existing, missing`);
    }
    const updates = packages.length - packages.filter((p) => plannedNew(p.item.pid)).length;
    report({ message: `PLAN total=${packages.length} update=${updates} create=${packages.length - updates} conflicts=${conflicts.length}` });
    for (const message of conflicts) report({ message: `CONFLICT ${message}` });
    if (!arg.apply) return { dryRun: true, conflicts };
    if (conflicts.length) throw new Error('Import blocked by PID conflict');

    let done = 0;
    for (const p of packages) {
        const { item, statement, dataDir, names } = p;
        report({ message: `START ${item.pid}` });
        const current = await coll.findOne({ domainId: DOMAIN, docType: 10, pid: item.pid });
        const originally = byPid.get(item.pid);
        if (originally && current?.docId !== originally.docId) throw new Error(`docId changed: ${item.pid}`);
        if (!originally && current) throw new Error(`PID became occupied: ${item.pid}`);
        if (plannedNew(item.pid) && current && progress[item.pid] === current.docId) {
            if (current.owner !== operator) {
                await ProblemModel.edit(DOMAIN, current.docId, { owner: operator });
                const updated = await coll.findOne({ domainId: DOMAIN, docType: 10, pid: item.pid });
                if (updated?.owner !== operator) throw new Error(`Owner verification failed: ${item.pid}`);
            }
            done++;
            report({ message: `${done}/${packages.length} RESUME-SKIP ${item.pid} docId=${current.docId} owner=${operator}` });
            continue;
        }
        let docId = current?.docId;
        if (!current) {
            docId = await ProblemModel.add(DOMAIN, item.pid, item.title, JSON.stringify({ zh: statement }), operator, [item.root, item.chapter]);
            const created = await coll.findOne({ domainId: DOMAIN, docType: 10, pid: item.pid });
            if (created?.docId !== docId) throw new Error(`New PID mismatch: ${item.pid}`);
        }
        for (const name of names) {
            await ProblemModel.addTestdata(DOMAIN, docId, name, path.join(dataDir, name), operator);
        }
        const stored = await coll.findOne({ domainId: DOMAIN, docType: 10, docId });
        const storedFiles = new Map((stored?.data || []).map((f) => [f.name || f._id, f]));
        const missing = names.filter((name) => {
            const info = storedFiles.get(name);
            return !info || info.size !== fs.statSync(path.join(dataDir, name)).size;
        });
        if (missing.length) throw new Error(`Uploaded metadata missing: ${item.pid} ${missing.join(',')}`);
        if (current) {
            await ProblemModel.edit(DOMAIN, docId, {
                content: JSON.stringify({ zh: statement }),
                owner: operator,
            });
            const stale = (current.data || []).map((f) => f.name || f._id).filter((name) => !names.includes(name));
            if (stale.length) await ProblemModel.delTestdata(DOMAIN, docId, stale, operator);
        }
        const after = await coll.findOne({ domainId: DOMAIN, docType: 10, pid: item.pid });
        if (after?.docId !== docId || after.content !== JSON.stringify({ zh: statement }) || after.owner !== operator) {
            throw new Error(`Verification failed: ${item.pid}`);
        }
        if (plannedNew(item.pid) && !progress[item.pid]) {
            progress[item.pid] = docId;
            const tempPath = `${progressPath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify(progress, null, 2));
            fs.renameSync(tempPath, progressPath);
        }
        done++;
        const action = current ? 'UPDATE' : 'NEW';
        report({ message: `${done}/${packages.length} ${action} ${item.pid} docId=${docId} owner=${operator} files=${names.length}` });
    }
    return { done };
}

const apply = (ctx) => ctx.addScript('hgnuImport413', 'HGNU Hydro 4.13.4 import', Schema.any(), run);
module.exports = { apply, run, plannedNew, readPackages };
