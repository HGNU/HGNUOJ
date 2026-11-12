/* eslint-disable no-await-in-loop -- Preserve ordered updates and progress checkpoints. */
const schemastery = require('schemastery');
const Schema = schemastery.default?.any ? schemastery.default : schemastery;
const RecordModel = require('../model/record').default;
const db = require('../service/db').default;

async function run(arg = {}, report = console.log) {
    const domainId = arg.domain || 'system';
    const uid = Number(arg.uid || 0);
    const limit = Math.min(Math.max(Number(arg.limit || 200), 1), 50000);
    const apply = !!arg.apply;
    const match = { domainId, status: 0 };
    if (uid) match.uid = uid;
    const coll = db.collection('record');
    const total = await coll.countDocuments(match);
    const pids = await coll.aggregate([
        { $match: match },
        { $group: { _id: '$pid' } },
        { $sort: { _id: 1 } },
    ]).toArray();
    report({ message: `PENDING ${total} waiting records across ${pids.length} problems` });
    if (!apply) return { total };
    let enqueued = 0;
    let problems = 0;
    for (const row of pids) {
        if (enqueued >= limit) break;
        const take = Math.min(limit - enqueued, 50000);
        const rids = await coll.find({ ...match, pid: row._id })
            .sort({ _id: 1 }).limit(take).project({ _id: 1 }).toArray();
        if (!rids.length) continue;
        await RecordModel.judge(domainId, rids.map((r) => r._id), 0, {}, { type: 'judge', rejudge: true });
        enqueued += rids.length;
        problems++;
    }
    report({ message: `DONE enqueued=${enqueued} problems=${problems} remaining=${total - enqueued}` });
    return { enqueued, remaining: total - enqueued };
}

const apply = (ctx) => ctx.addScript('hgnuRejudgeBatch', 'Re-enqueue waiting records in batches', Schema.any(), run);
module.exports = { apply, run };
