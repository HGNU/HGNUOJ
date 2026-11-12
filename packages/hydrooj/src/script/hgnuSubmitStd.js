// 批量提交题包 std.cpp 到学校 Hydro OJ（4.13.4 脚本格式）
// 复制到 /opt/HGNUOJ-Hydro/Hydro/packages/hydrooj/src/script/hgnuSubmitStd.js
//
// 预览：  hydrooj cli script hgnuSubmitStd '{"base":"/root/hydro_export","uid":607}'
// 提交：  hydrooj cli script hgnuSubmitStd '{"base":"/root/hydro_export","uid":607,"apply":true}'
// 查结果：hydrooj cli script hgnuSubmitStd '{"base":"/root/hydro_export","uid":607,"check":true}'
//
// 可选参数：
//   only: "P5007" 或题名片段，只处理匹配的题
//   lang: 默认 cc.cc17o2（C++17 + O2）
//   delay: 每题间隔毫秒，默认 300
//   skipAccepted: 默认 true，已有 AC 记录的题跳过
const fs = require('fs');
const path = require('path');
const schemastery = require('schemastery');
const Schema = schemastery.default?.any ? schemastery.default : schemastery;
const ProblemModel = require('../model/problem').default;
const RecordModel = require('../model/record').default;
const db = require('../service/db').default;
const { STATUS, STATUS_TEXTS } = require('@hydrooj/utils/lib/status');

const DOMAIN = 'system';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadItems(base, only, pidSet) {
    const root = path.resolve(base);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (!Array.isArray(manifest)) throw new Error('manifest.json must be an array');
    return manifest
        .filter((x) => (!pidSet || pidSet.has(x.pid))
            && (!only || x.pid === only || String(x.title).includes(only)))
        .map((x) => ({ ...x, stdFile: path.join(root, 'std', x.pid + '.cpp') }));
}

async function run(arg = {}, report = console.log) {
    const base = arg.base || '/root/hydro_export';
    const uid = Number(arg.uid);
    const lang = arg.lang || 'cc.cc17o2';
    const delay = Math.max(0, Number(arg.delay ?? 300));
    const only = arg.only || '';
    const apply = !!arg.apply;
    const check = !!arg.check;
    const skipAccepted = arg.skipAccepted !== false;
    let pidSet = null;
    if (Array.isArray(arg.pids)) pidSet = new Set(arg.pids.map(String));
    else if (arg.list) {
        const listPath = path.resolve(arg.list);
        pidSet = new Set(Object.keys(JSON.parse(fs.readFileSync(listPath, 'utf8'))));
    }
    if (apply && (!Number.isSafeInteger(uid) || uid < 1)) throw new Error('apply 需要正整数 uid');
    if (check && (!Number.isSafeInteger(uid) || uid < 1)) throw new Error('check 需要正整数 uid');

    const items = loadItems(base, only, pidSet);
    const missing = items.filter((x) => !fs.existsSync(x.stdFile));
    if (missing.length) {
        throw new Error('缺少 std 文件: ' + missing.slice(0, 10).map((x) => x.pid).join(', '));
    }

    const coll = db.collection('record');
    const statusText = (s) => (STATUS_TEXTS && STATUS_TEXTS[s]) || String(s);

    if (check) {
        const counts = {};
        const bad = [];
        for (const item of items) {
            const pdoc = await ProblemModel.get(DOMAIN, item.pid);
            if (!pdoc) {
                bad.push([item.pid, 'MISSING_PROBLEM']);
                continue;
            }
            const r = await coll.findOne({ domainId: DOMAIN, pid: pdoc.docId, uid }, { sort: { _id: -1 } });
            if (!r) {
                counts.NO_RECORD = (counts.NO_RECORD || 0) + 1;
                bad.push([item.pid, 'NO_RECORD']);
                continue;
            }
            const key = statusText(r.status);
            counts[key] = (counts[key] || 0) + 1;
            if (r.status !== STATUS.STATUS_ACCEPTED) bad.push([item.pid, key, r.score]);
        }
        report({ message: 'CHECK ' + JSON.stringify(counts) });
        if (bad.length) report({ message: 'NOT_AC ' + JSON.stringify(bad.slice(0, 50)) });
        return { checked: items.length, counts, bad: bad.length };
    }

    if (!apply) {
        report({
            message: `PLAN submit=${items.length} uid=${uid} lang=${lang} delay=${delay}ms skipAccepted=${skipAccepted}`,
        });
        return { total: items.length };
    }

    let submitted = 0;
    let skipped = 0;
    const failed = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
            const pdoc = await ProblemModel.get(DOMAIN, item.pid);
            if (!pdoc) throw new Error('题目不存在');
            if (skipAccepted) {
                const ac = await coll.findOne({
                    domainId: DOMAIN, pid: pdoc.docId, uid, status: STATUS.STATUS_ACCEPTED,
                });
                if (ac) {
                    skipped++;
                    report({ message: `${i + 1}/${items.length} SKIP-AC ${item.pid}` });
                    continue;
                }
            }
            const code = fs.readFileSync(item.stdFile, 'utf8');
            const rid = await RecordModel.add(DOMAIN, pdoc.docId, uid, lang, code, true);
            submitted++;
            report({ message: `${i + 1}/${items.length} SUBMIT ${item.pid} ${item.title} rid=${rid}` });
            if (delay) await sleep(delay);
        } catch (e) {
            failed.push(`${item.pid}: ${e.message}`);
            report({ message: `${i + 1}/${items.length} FAIL ${item.pid}: ${e.message}` });
        }
    }
    report({ message: `DONE submitted=${submitted} skippedAC=${skipped} failed=${failed.length}` });
    if (failed.length) report({ message: failed.join('\n') });
    return { submitted, skipped, failed: failed.length };
}

const apply = (ctx) => ctx.addScript('hgnuSubmitStd', 'Submit std.cpp to problems', Schema.any(), run);
module.exports = { apply, run, loadItems };
