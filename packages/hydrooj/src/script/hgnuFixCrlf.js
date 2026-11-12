// 将测试数据中的 CRLF 规范为 LF 并覆盖 OJ 上的对应文件。
// 复制到 /opt/HGNUOJ-Hydro/Hydro/packages/hydrooj/src/script/hgnuFixCrlf.js
// 预览：hydrooj cli script hgnuFixCrlf '{"base":"/root/hydro_export","list":"/root/hydro_export/crlf_fix_in.json"}'
// 执行：加 "apply":true；可用 "pids":["P4963"] 只处理部分题。
const fs = require('fs');
const path = require('path');
const schemastery = require('schemastery');
const Schema = schemastery.default?.any ? schemastery.default : schemastery;
const ProblemModel = require('../model/problem').default;

const DOMAIN = 'system';

async function run(arg = {}, report = console.log) {
    const base = path.resolve(arg.base || '/root/hydro_export');
    const listPath = path.resolve(arg.list || path.join(base, 'crlf_fix_in.json'));
    const uid = Number(arg.uid || 607);
    const apply = !!arg.apply;
    const only = Array.isArray(arg.pids) ? new Set(arg.pids.map(String)) : null;
    const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    let problems = 0;
    let files = 0;
    for (const pid of Object.keys(list)) {
        if (only && !only.has(pid)) continue;
        const pdoc = await ProblemModel.get(DOMAIN, pid);
        if (!pdoc) {
            report({ message: `MISSING ${pid}` });
            continue;
        }
        const td = path.join(base, 'problems', pid, 'testdata');
        const names = new Set(list[pid]);
        for (const name of list[pid]) {
            const stem = name.replace(/\.in$/, '');
            if (fs.existsSync(path.join(td, stem + '.out'))) names.add(stem + '.out');
        }
        for (const name of names) {
            const p = path.join(td, name);
            if (!fs.existsSync(p)) continue;
            const old = fs.readFileSync(p);
            const text = old.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const buf = Buffer.from(text, 'utf8');
            if (buf.equals(old)) continue;
            if (apply) await ProblemModel.addTestdata(DOMAIN, pdoc.docId, name, buf, uid);
            files++;
        }
        problems++;
        report({ message: `${problems} ${pid} docId=${pdoc.docId}` });
    }
    report({ message: `DONE problems=${problems} files=${files} apply=${apply}` });
    return { problems, files };
}

const apply = (ctx) => ctx.addScript('hgnuFixCrlf', 'Normalize CRLF in testdata', Schema.any(), run);
module.exports = { apply, run };
