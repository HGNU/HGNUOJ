/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-await-in-loop */
/* eslint-disable @typescript-eslint/naming-convention */
import yaml from 'js-yaml';
import { pick } from 'lodash';
import moment from 'moment';
import { ObjectID } from 'mongodb';
import { buildContent } from './lib/content';
import { Logger } from './logger';
import { PERM, PRIV, STATUS } from './model/builtin';
import * as contest from './model/contest';
import * as discussion from './model/discussion';
import * as document from './model/document';
import domain from './model/domain';
import MessageModel from './model/message';
import problem from './model/problem';
import RecordModel from './model/record';
import * as system from './model/system';
import TaskModel from './model/task';
import user from './model/user';
import {
    iterateAllDomain, iterateAllProblem, iterateAllUser,
} from './pipelineUtils';
import db from './service/db';
import { setBuiltinConfig } from './settings';
import welcome from './welcome';

const logger = new Logger('upgrade');
type UpgradeScript = void | (() => Promise<boolean | void>);
const unsupportedUpgrade = async function _26_27() {
    const _FRESH_INSTALL_IGNORE = 1;
    throw new Error('This upgrade was no longer supported in hydrooj@4. \
Please use hydrooj@3 to perform these upgrades before upgrading to v4');
};

const scripts: UpgradeScript[] = [
    // Mark as used
    null,
    // Init
    async function _1_2() {
        const ddoc = await domain.get('system');
        if (!ddoc) await domain.add('system', 1, 'Hydro', 'Welcome to Hydro!');
        await welcome();
        // TODO discussion node?
        return true;
    },
    ...new Array(25).fill(unsupportedUpgrade),
    async function _27_28() {
        const _FRESH_INSTALL_IGNORE = 1;
        const cursor = document.coll.find({ docType: document.TYPE_DISCUSSION });
        while (await cursor.hasNext()) {
            const data = await cursor.next();
            const t = Math.exp(-0.15 * (((new Date().getTime() / 1000) - data._id.generationTime) / 3600));
            const rCount = await discussion.getMultiReply(data.domainId, data.docId).count();
            const sort = ((data.sort || 100) + Math.max(rCount - (data.lastRCount || 0), 0) * 10) * t;
            await document.coll.updateOne({ _id: data._id }, { $set: { sort, lastRCount: rCount } });
        }
        return true;
    },
    async function _28_29() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllProblem(['content', 'html'], async (pdoc) => {
            try {
                const parsed = JSON.parse(pdoc.content);
                if (parsed instanceof Array) {
                    await problem.edit(pdoc.domainId, pdoc.docId, { content: buildContent(parsed, pdoc.html ? 'html' : 'markdown') });
                    return;
                }
                const res = {};
                for (const key in parsed) {
                    if (typeof parsed[key] === 'string') res[key] = parsed[key];
                    else res[key] = buildContent(parsed[key]);
                }
                await problem.edit(pdoc.domainId, pdoc.docId, { content: JSON.stringify(res) });
            } catch { }
        });
        return true;
    },
    async function _29_30() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllDomain((ddoc) => RecordModel.coll.updateMany({ domainId: ddoc._id }, { $set: { pdomain: ddoc._id } }));
        return true;
    },
    // Add send_message priv to user
    async function _30_31() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllUser((udoc) => user.setPriv(udoc._id, udoc.priv | PRIV.PRIV_SEND_MESSAGE));
        return true;
    },
    null,
    // Write builtin users to database
    async function _32_33() {
        if (!await user.getById('system', 0)) {
            await user.create('Guest@hydro.local', 'Guest', String.random(32), 0, '127.0.0.1', PRIV.PRIV_REGISTER_USER);
        }
        if (!await user.getById('system', 1)) {
            await user.create('Hydro@hydro.local', 'Hydro', String.random(32), 1, '127.0.0.1', PRIV.PRIV_USER_PROFILE);
        }
        return true;
    },
    async function _33_34() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllProblem(['content'], async (pdoc) => {
            if (typeof pdoc.content !== 'string') return;
            await problem.edit(pdoc.domainId, pdoc.docId, { content: pdoc.content.replace(/%file%:\/\//g, 'file://') });
        });
        return true;
    },
    async function _34_35() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllDomain((ddoc) => domain.edit(ddoc._id, { lower: ddoc._id.toLowerCase() }));
        return true;
    },
    async function _35_36() {
        const _FRESH_INSTALL_IGNORE = 1;
        await RecordModel.coll.updateMany({}, { $unset: { effective: '' } });
        return true;
    },
    async function _36_37() {
        const _FRESH_INSTALL_IGNORE = 1;
        const cur = document.collStatus.find();
        while (await cur.hasNext()) {
            const doc = await cur.next();
            await document.collStatus.deleteMany({
                ...pick(doc, ['docId', 'domainId', 'uid', 'docType']),
                _id: { $gt: doc._id },
            });
        }
        return true;
    },
    async function _37_38() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllProblem(['docId', 'domainId', 'config'], async (pdoc) => {
            logger.info('%s/%s', pdoc.domainId, pdoc.docId);
            if (typeof pdoc.config !== 'string') return;
            if (!pdoc.config.includes('type: subjective')) return;
            await problem.addTestdata(
                pdoc.domainId, pdoc.docId, 'config.yaml',
                Buffer.from(pdoc.config.replace('type: subjective', 'type: objective')),
            );
        });
        return true;
    },
    async function _38_39() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllDomain(async (ddoc) => {
            ddoc.roles.root = '-1';
            await domain.setRoles(ddoc._id, ddoc.roles);
        });
        return true;
    },
    async function _39_40() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllDomain(async ({ _id }) => {
            const ddocs = await discussion.getMulti(_id, { parentType: document.TYPE_PROBLEM }).toArray();
            for (const ddoc of ddocs) {
                const pdoc = await problem.get(_id, ddoc.parentId as any);
                await document.set(_id, document.TYPE_DISCUSSION, ddoc.docId, { parentId: pdoc.docId });
            }
        });
        return true;
    },
    async function _40_41() {
        const _FRESH_INSTALL_IGNORE = 1;
        // Ignore drop index failure
        await db.collection('storage').dropIndex('path_1').catch(() => { });
        await db.collection('storage').updateMany(
            { autoDelete: { $gte: moment().add(5, 'days').toDate() } },
            { $unset: { autoDelete: '' } },
        );
        return true;
    },
    async function _41_42() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllDomain(async (ddoc) => {
            const cursor = discussion.getMulti(ddoc._id, { parentType: document.TYPE_CONTEST });
            while (await cursor.hasNext()) {
                const doc = await cursor.next();
                const tdoc = await document.coll.findOne({ docType: doc.parentType, docId: doc.parentId });
                if (!tdoc) await discussion.del(ddoc._id, doc.docId);
            }
        });
        return true;
    },
    async function _42_43() {
        const _FRESH_INSTALL_IGNORE = 1;
        const processer = (i) => {
            i.status = i.accept ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER;
            return i;
        };
        await iterateAllDomain(async (ddoc) => {
            const tdocs = await contest.getMulti(ddoc._id, { rule: 'acm' }).toArray();
            for (const tdoc of tdocs) {
                const tsdocs = await contest.getMultiStatus(ddoc._id, { docId: tdoc.docId }).toArray();
                for (const tsdoc of tsdocs) {
                    const $set: any = {};
                    if (tsdoc.journal?.length) $set.journal = tsdoc.journal.map(processer);
                    if (tsdoc.detail?.length) $set.detail = tsdoc.detail.map(processer);
                    if (Object.keys($set).length) {
                        await contest.setStatus(ddoc._id, tdoc.docId, tsdoc.uid, $set);
                    }
                }
            }
        });
        return true;
    },
    async function _43_44() {
        const _FRESH_INSTALL_IGNORE = 1;
        const processer = (i) => {
            i.status = i.accept ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER;
            return i;
        };
        await iterateAllDomain(async (ddoc) => {
            const tdocs = await contest.getMulti(ddoc._id, { rule: { $ne: 'acm' } }).toArray();
            for (const tdoc of tdocs) {
                const tsdocs = await contest.getMultiStatus(ddoc._id, { docId: tdoc.docId }).toArray();
                for (const tsdoc of tsdocs) {
                    const $set: any = {};
                    if (tsdoc.journal?.length) $set.journal = tsdoc.journal.map(processer);
                    if (tsdoc.detail?.length) $set.detail = tsdoc.detail.map(processer);
                    if (Object.keys($set).length) {
                        await contest.setStatus(ddoc._id, tdoc.docId, tsdoc.uid, $set);
                    }
                }
            }
        });
        return true;
    },
    async function _44_45() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllUser((udoc) => user.setById(udoc._id, { ip: [udoc.regip] }, { regip: '' }));
        return true;
    },
    async function _45_46() {
        const _FRESH_INSTALL_IGNORE = 1;
        await iterateAllDomain(async (ddoc) => {
            const ddocs = await discussion.getMulti(ddoc._id, {
                docType: document.TYPE_DISCUSSION,
                parentType: { $in: [document.TYPE_CONTEST, 60, document.TYPE_TRAINING] },
                parentId: { $type: 'string' },
            }).toArray();
            for (const doc of ddocs) {
                if (ObjectID.isValid(doc.parentId)) {
                    await document.set(ddoc._id, document.TYPE_DISCUSSION, doc.docId, { parentId: new ObjectID(doc.parentId) });
                }
            }
        });
        return true;
    },
    null,
    async function _47_48() {
        const _FRESH_INSTALL_IGNORE = 1;
        await document.coll.updateMany({ docType: document.TYPE_HOMEWORK }, { $set: { docType: document.TYPE_CONTEST } });
        await document.collStatus.updateMany({ docType: document.TYPE_HOMEWORK }, { $set: { docType: document.TYPE_CONTEST } });
        await RecordModel.coll.deleteMany({ 'contest.tid': { $ne: null }, hidden: true });
        await RecordModel.coll.updateMany({}, { $unset: { hidden: '' } });
        await RecordModel.coll.updateMany({ 'contest.tid': { $exists: true } }, { $rename: { 'contest.tid': 'contest1' } });
        await RecordModel.coll.updateMany({ contest1: { $exists: true } }, { $rename: { contest1: 'contest' } });
        await RecordModel.coll.updateMany({ contest: null }, { $unset: { contest: '' } });
        return true;
    },
    async function _48_49() {
        const _FRESH_INSTALL_IGNORE = 1;
        await RecordModel.coll.updateMany({ input: { $exists: true } }, { $set: { contest: new ObjectID('000000000000000000000000') } });
        return true;
    },
    async function _49_50() {
        const _FRESH_INSTALL_IGNORE = 1;
        await db.collection('user').updateMany({}, { $unset: { ratingHistory: '' } });
        await db.collection('domain').updateMany({}, { $unset: { pidCounter: '' } });
        return true;
    },
    async function _50_51() {
        const _FRESH_INSTALL_IGNORE = 1;
        await db.collection('domain.user').updateMany({}, { $unset: { ratingHistory: '' } });
        return true;
    },
    async function _51_52() {
        const _FRESH_INSTALL_IGNORE = 1;
        const mapping: Record<string, number> = {};
        const isStringPid = (i: string) => i.toString().includes(':');
        async function getProblem(domainId: string, target: string) {
            if (!target.toString().includes(':')) return await problem.get(domainId, target);
            const l = `${domainId}/${target}`;
            if (mapping[l]) return await problem.get(domainId, mapping[l]);
            const [sourceDomain, sourceProblem] = target.split(':');
            const docId = await problem.copy(sourceDomain, +sourceProblem, domainId);
            mapping[l] = docId;
            return await problem.get(domainId, docId);
        }
        const cursor = db.collection('document').find({ docType: document.TYPE_CONTEST });
        while (await cursor.hasNext()) {
            const doc = await cursor.next();
            const pids = [];
            let mark = false;
            for (const pid of doc.pids) {
                if (pid.toString().includes(':')) {
                    mark = true;
                    const pdoc = await getProblem(doc.domainId, pid);
                    if (pdoc) {
                        pids.push(pdoc.docId);
                        await RecordModel.updateMulti(
                            doc.domainId,
                            { contest: doc.docId, pid },
                            { pid: pdoc.docId },
                            {},
                            { pdomain: '' },
                        );
                    }
                } else pids.push(pid);
            }
            if (mark) {
                const ctdocs = await document.getMultiStatus(
                    doc.domainId, document.TYPE_CONTEST, { docId: doc.docId },
                ).toArray();
                for (const ctdoc of ctdocs) {
                    if (!ctdoc.journal?.filter((i) => isStringPid(i.pid)).length) continue;
                    const journal = [];
                    for (const i of ctdoc.journal) {
                        const pdoc = await getProblem(doc.domainId, i.pid);
                        if (pdoc) i.pid = pdoc.docId;
                        journal.push(i);
                    }
                    const $set = { journal };
                    await document.setStatus(doc.domainId, doc.docType, doc.docId, ctdoc.uid, $set);
                }
                await contest.edit(doc.domainId, doc.docId, { pids });
                await contest.recalcStatus(doc.domainId, doc.docId);
            }
        }
        await db.collection('record').updateMany({}, { $unset: { pdomain: '' } });
        return true;
    },
    async function _52_53() {
        const _FRESH_INSTALL_IGNORE = 1;
        const cursor = db.collection('document').find({ docType: document.TYPE_CONTEST });
        while (await cursor.hasNext()) {
            const tdoc = await cursor.next();
            const pdocs = await problem.getMulti(tdoc.domainId, { docId: { $in: tdoc.pids } }).toArray();
            if (!pdocs.filter((i) => i.reference).length) continue;
            const tsdocs = await contest.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }).toArray();
            for (const tsdoc of tsdocs) {
                for (const tsrdoc of tsdoc.journal) {
                    await RecordModel.coll.updateOne({ _id: tsrdoc.rid }, { pid: tsrdoc.pid });
                }
            }
        }
        return true;
    },
    async function _53_54() {
        const _FRESH_INSTALL_IGNORE = 1;
        let ddocs = await db.collection('document').find({ docType: 21, parentType: 10 })
            .project({ _id: 1, parentId: 1 }).toArray();
        ddocs = ddocs.filter((i) => Number.isSafeInteger(+i.parentId));
        if (ddocs.length) {
            const bulk = db.collection('document').initializeUnorderedBulkOp();
            for (const ddoc of ddocs) {
                bulk.find({ _id: ddoc._id }).updateOne({ $set: { parentId: +ddoc.parentId } });
            }
            await bulk.execute();
        }
        return true;
    },
    async function _54_55() {
        const _FRESH_INSTALL_IGNORE = 1;
        const bulk = db.collection('document').initializeUnorderedBulkOp();
        function sortable(source: string) {
            return source.replace(/(\d+)/g, (str) => (str.length >= 6 ? str : ('0'.repeat(6 - str.length) + str)));
        }
        await iterateAllProblem(['pid', '_id'], async (pdoc) => {
            bulk.find({ _id: pdoc._id }).updateOne({ $set: { sort: sortable(pdoc.pid || `P${pdoc.docId}`) } });
        });
        if (bulk.length) await bulk.execute();
        return true;
    },
    async function _55_56() {
        const _FRESH_INSTALL_IGNORE = 1;
        await db.collection('document').updateMany({ docType: document.TYPE_PROBLEM }, { $unset: { difficulty: '' } });
        return true;
    },
    async function _56_57() {
        const _FRESH_INSTALL_IGNORE = 1;
        await db.collection('oplog').deleteMany({ type: 'user.login' });
        return true;
    },
    async function _57_58() {
        const _FRESH_INSTALL_IGNORE = 1;
        await db.collection('document').updateMany(
            { docType: document.TYPE_PROBLEM, assign: null },
            { $set: { assign: [] } },
        );
        return true;
    },
    async function _58_59() {
        const _FRESH_INSTALL_IGNORE = 1;
        const tasks = await db.collection('task').find({ type: 'schedule', subType: 'contest.problemHide' }).toArray();
        for (const task of tasks) {
            await TaskModel.add({ ...task, subType: 'contest', operation: ['unhide'] });
        }
        await TaskModel.deleteMany({ type: 'schedule', subType: 'contest.problemHide' });
        return true;
    },
    async function _59_60() {
        const langs = await system.get('hydrooj.langs');
        await system.set('hydrooj.langs', langs.replace(/\$\{dir\}/g, '/w').replace(/\$\{name\}/g, 'foo'));
        return true;
    },
    async function _60_61() {
        const config = await system.get('hydrooj.homepage');
        const data = yaml.load(config) as any;
        if (!(data instanceof Array)) {
            await system.set('hydrooj.homepage', yaml.dump([
                { width: 9, bulletin: true, ...data },
                {
                    width: 3, hitokoto: true, starred_problems: 50, discussion_nodes: true, suggestion: true,
                },
            ]));
        }
        return true;
    },
    async function _61_62() {
        const _FRESH_INSTALL_IGNORE = 1;
        const priv = +system.get('default.priv');
        if (priv & PRIV.PRIV_REGISTER_USER) {
            const udocs = await user.getMulti({ priv }).project({ _id: 1 }).toArray();
            for (const udoc of udocs) {
                await user.setById(udoc._id, { priv: priv - PRIV.PRIV_REGISTER_USER });
            }
            await system.set('default.priv', priv - PRIV.PRIV_REGISTER_USER);
        }
        return true;
    },
    async function _62_63() {
        const _FRESH_INSTALL_IGNORE = 1;
        const uids = new Set<number>();
        await iterateAllDomain(async (ddoc) => {
            const pdocs = await problem.getMulti(ddoc._id, { config: /type: objective/ })
                .project({
                    config: 1, content: 1, docId: 1, owner: 1,
                }).toArray();
            for (const pdoc of pdocs) {
                try {
                    const config = yaml.load(pdoc.config as string) as any;
                    if (config.type !== 'objective' || !config.outputs) continue;
                    config.answers = {};
                    let cnt = 0;
                    for (const l of config.outputs) {
                        cnt++;
                        config.answers[cnt] = l;
                    }

                    function processSingleLanguage(content: string) { // eslint-disable-line no-inner-declarations
                        let text = '';
                        try {
                            let scnt = 0;
                            const doc = yaml.load(content);
                            if (!(doc instanceof Array)) return content;
                            for (const s of doc) {
                                scnt++;
                                text += `${scnt}. ${s.desc}\n`;
                                if (s.choices) {
                                    text += `{{ select(${scnt}) }}\n`;
                                    const isPrefixed = s.choices.every((c) => /^[A-Z]\./.test(c));
                                    let selectionId = 64;
                                    for (const c of s.choices) {
                                        selectionId++;
                                        text += `- ${isPrefixed ? c.replace(/^[A-Z]\./, '') : c}\n`;
                                        if (config.answers[scnt][0] === c) config.answers[scnt][0] = String.fromCharCode(selectionId);
                                    }
                                } else text += `{{ input(${scnt}) }}\n`;
                                text += '\n';
                            }
                        } catch (e) { console.error(e); return content; }
                        return text;
                    }

                    try {
                        const langs = JSON.parse(pdoc.content);
                        if (typeof langs === 'object' && !(langs instanceof Array)) {
                            for (const lang in langs) {
                                if (typeof langs[lang] !== 'string') continue;
                                langs[lang] = processSingleLanguage(langs[lang]);
                            }
                            await problem.edit(ddoc._id, pdoc.docId, { content: JSON.stringify(langs) });
                        }
                    } catch (e) {
                        const content = processSingleLanguage(pdoc.content);
                        await problem.edit(ddoc._id, pdoc.docId, { content });
                    }
                    uids.add(pdoc.owner);
                    delete config.outputs;
                    await problem.addTestdata(ddoc._id, pdoc.docId, 'config.yaml', Buffer.from(yaml.dump(config)));
                } catch (e) { console.error(e); }
            }
        });
        for (const uid of uids) {
            await MessageModel.send(1, uid, '我们更新了客观题的配置格式，已有题目已自动转换，查看文档获得更多信息。', MessageModel.FLAG_UNREAD);
        }
        return true;
    },
    async function _63_64() {
        await db.collection('document').updateMany(
            { rule: 'homework', penaltySince: { $exists: false } },
            { $set: { penaltySince: new Date() } },
        );
        return true;
    },
    async function _64_65() {
        await system.set('server.center', 'https://hydro.ac/center');
        return true;
    },
    async function _65_66() {
        await iterateAllDomain(async (ddoc) => {
            Object.keys(ddoc.roles).forEach((role) => {
                if (['guest', 'root'].includes(role)) return;
                ddoc.roles[role] = (BigInt(ddoc.roles[role]) | PERM.PREM_VIEW_DISPLAYNAME).toString();
            });
            await domain.setRoles(ddoc._id, ddoc.roles);
        });
        return true;
    },
    async function _66_67() {
        const [
            endPoint, accessKey, secretKey, bucket, region,
            pathStyle, endPointForUser, endPointForJudge,
        ] = system.getMany([
            'file.endPoint', 'file.accessKey', 'file.secretKey', 'file.bucket', 'file.region',
            'file.pathStyle', 'file.endPointForUser', 'file.endPointForJudge',
        ] as any[]) as any;
        if ((endPoint && accessKey) || process.env.MINIO_ACCESS_KEY) {
            await setBuiltinConfig('file', {
                type: 's3',
                endPoint: process.env.MINIO_ACCESS_KEY ? 'http://127.0.0.1:9000/' : endPoint,
                accessKey: process.env.MINIO_ACCESS_KEY || accessKey,
                secretKey: process.env.MINIO_SECRET_KEY || secretKey,
                bucket,
                region,
                pathStyle,
                endPointForUser,
                endPointForJudge,
            });
            setTimeout(() => {
                logger.info('Upgrade done. please restart the server.');
                process.exit(0);
            }, 1000);
        }
        return true;
    },
    async function _67_68() {
        const _FRESH_INSTALL_IGNORE = 1;
        const rdocs = RecordModel.coll.find({ code: /^@@hydro_submission_file@@/ });
        let rdoc;
        while (rdoc = await rdocs.next()) { // eslint-disable-line
            await RecordModel.update(rdoc.domainId, rdoc._id, {
                files: { code: rdoc.code.split('@@hydro_submission_file@@')[1] },
                code: '',
            });
        }
        return true;
    },
    async function _68_69() {
        const _FRESH_INSTALL_IGNORE = 1;
        await db.collection('cache' as any).deleteMany({});
        return true;
    },
];

export default scripts;
