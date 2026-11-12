import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Schema from 'schemastery';
import { STATUS } from '@hydrooj/common';
import { getConfig, overrideConfig } from '../packages/hydrojudge/src/config';
import { runFlow } from '../packages/hydrojudge/src/flow';
import { RULES } from '../packages/hydrooj/src/model/contest';
import StudentModel, { deleteStudentCache, validateStudentInfo } from '../packages/hydrooj/src/model/stuinfo';
import UserModel, { deleteUserCache } from '../packages/hydrooj/src/model/user';
import db from '../packages/hydrooj/src/service/db';
import { SettingService } from '../packages/hydrooj/src/settings';

// Run through `hydrooj cli execute` after bootstrapping an isolated test database.
// Never run fixture mutations against a production database.
export async function run() {
    assert.match(db.db.databaseName, /(?:test|upgrade)/i);
    const results: string[] = [];
    const prefix = `hgnu_upgrade_${randomBytes(4).toString('hex')}`;
    const uids = new Set<number>();
    const create = async (suffix: string, stuid: string) => {
        const uid = await StudentModel.createAccount(`${prefix}${suffix}@invalid.local`, `${prefix}${suffix}`, 'HGNU-Test-Password-2026', {
            name: '测试', class: '测试2601', stuid,
        });
        uids.add(uid);
        return uid;
    };
    try {
        assert.throws(() => validateStudentInfo({ stuid: '220260001junk' }));
        assert.throws(() => validateStudentInfo({ stuid: 'prefix2020310120000' }));
        validateStudentInfo({ stuid: '29999998' });
        results.push('student-id anchors');

        const uid = await create('a', '29999998');
        await UserModel.getByUname('system', `${prefix}a`);
        await UserModel.getByEmail('system', `${prefix}a@invalid.local`);
        await StudentModel.getStuInfoByStuId('29999998');
        await StudentModel.getClassList();
        await UserModel.setById(uid, { class: '测试2602', stuid: '29999997' } as any);
        assert.equal(await StudentModel.getStuInfoByStuId('29999998'), null);
        assert.equal((await StudentModel.getStuInfoByStuId('29999997'))._id, uid);
        for (const user of await Promise.all([
            UserModel.getById('system', uid),
            UserModel.getByUname('system', `${prefix}a`),
            UserModel.getByEmail('system', `${prefix}a@invalid.local`),
        ])) assert.equal(user.class, '测试2602');
        const users = await UserModel.getListForRender('system', [uid], false);
        assert.equal(users[uid].name, '测试');
        assert.equal(users[uid].stuid, '29999997');
        assert.ok((await StudentModel.getClassList()).clsList.some((c) => c._id === '测试2602'));
        results.push('student and user cache invalidation; render fields; class membership');

        const race = await Promise.allSettled([create('b', '29999996'), create('c', '29999996')]);
        assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(await UserModel.coll.countDocuments({ uname: { $in: [`${prefix}b`, `${prefix}c`] } }), 1);
        results.push('duplicate student-id race rolls back the losing account');

        const originalCreate = StudentModel.create;
        try {
            StudentModel.create = async () => { throw new Error('fixture insertion failure'); };
            await assert.rejects(create('rollback', '29999995'), /fixture insertion failure/);
            assert.equal(await UserModel.coll.countDocuments({ uname: `${prefix}rollback` }), 0);
        } finally {
            StudentModel.create = originalCreate;
        }
        results.push('failed student insertion rolls back account creation');

        const user = await UserModel.getById('system', uid);
        for (const [name, rule] of Object.entries(RULES)) {
            for (const isExport of [false, true]) {
                const tdoc: any = { domainId: 'system', pids: [1], beginAt: new Date(0), endAt: new Date(1), rule: name };
                const pdict: any = { 1: { title: 'A+B', docId: 1 } };
                const config = { isExport, showDisplayName: true };
                const header = await rule.scoreboardHeader(config, (s) => s, tdoc, pdict);
                const row = await rule.scoreboardRow(config, (s) => s, tdoc, pdict, user, 1, {
                    uid, score: 100, penaltyScore: 80, time: 42, journal: [], detail: {}, display: {},
                } as any, {});
                assert.equal(header.length, row.length, `${name} export=${isExport}`);
                assert.equal(row[1].value, '测试2602');
                if (name === 'homework') assert.equal(row[3].value, '100');
            }
        }
        results.push('all six scoreboard rules have aligned columns; homework keeps raw totals');

        const oldConcurrency = getConfig('singleTaskParallelism');
        overrideConfig({ singleTaskParallelism: 1 } as any);
        try {
            for (const [type, expectedScore, expectedCalls] of [['sum', 100, 2], ['max', 100, 2], ['min', 0, 1]] as const) {
                let calls = 0;
                let result: any;
                const ctx: any = {
                    config: { count: 2, subtasks: [{ id: 1, type, score: 100, cases: [{ id: 1 }, { id: 2 }] }] },
                    meta: {}, next: () => {}, end: (value) => { result = value; },
                    startChildSpan: () => ({ setAttributes() {}, [Symbol.dispose]() {} }),
                };
                await runFlow(ctx, {
                    compile: async () => {},
                    judgeCase: (c) => async () => {
                        calls++;
                        return { id: c.id, subtaskId: 1, status: c.id === 1 ? STATUS.STATUS_WRONG_ANSWER : STATUS.STATUS_ACCEPTED,
                            score: c.id === 1 ? 0 : 100, time: 1, memory: 1, message: '' };
                    },
                });
                assert.equal(calls, expectedCalls, type);
                assert.equal(result.score, expectedScore, type);
            }
        } finally { overrideConfig({ singleTaskParallelism: oldConcurrency } as any); }
        results.push('sum/max continue after a wrong answer; min short-circuits');

        const migrated: string[] = [];
        const service: any = {
            initialValues: { 'server.port': 8889 }, systemConfig: {},
            ctx: { db: { collection: () => ({ updateOne: async () => {} }) }, logger: { info() {} } },
            applyDelta: (source, key, value) => { migrated.push(`${key}=${value}`); return source; },
            saveConfig: async () => {},
        };
        const schema = Schema.object({ server: Schema.object({ port: Schema.number() }) });
        await SettingService.prototype._actualMigrate.call(service, schema);
        await SettingService.prototype._actualMigrate.call(service, schema);
        assert.deepEqual(migrated, ['server.port=8889']);
        const failed: any = { ...service, initialValues: { 'server.port': 8889 }, saveConfig: async () => { throw new Error('save failed'); } };
        await assert.rejects(SettingService.prototype._actualMigrate.call(failed, schema), /save failed/);
        assert.equal(failed.initialValues['server.port__migrated'], undefined);
        results.push('legacy settings migration is idempotent and retries failed saves');
    } finally {
        // Include accounts created before an assertion fails, scoped to this random run.
        const created = await UserModel.coll.find({ uname: { $regex: `^${prefix}` } }).toArray();
        for (const user of created) { uids.add(user._id); deleteUserCache(user); }
        await db.collection('stu.info').deleteMany({ _id: { $in: [...uids] } });
        await db.collection('domain.user').deleteMany({ uid: { $in: [...uids] } });
        await UserModel.coll.deleteMany({ _id: { $in: [...uids] }, uname: { $regex: `^${prefix}` } });
        deleteStudentCache();
    }
    return { passed: results, fixturesRemoved: true };
}
