import { statSync } from 'fs-extra';
import yaml from 'js-yaml';
import { pick } from 'lodash';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import { sortFiles, Time } from '@hydrooj/utils/lib/utils';
import {
    ContestNotFoundError, FileLimitExceededError, FileUploadError, HomeworkNotLiveError, NotAssignedError, ValidationError,
} from '../error';
import { PenaltyRules, Tdoc } from '../interface';
import { PERM } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import * as oplog from '../model/oplog';
import problem from '../model/problem';
import record from '../model/record';
import storage from '../model/storage';
import * as system from '../model/system';
import user from '../model/user';
import {
    Handler, param, post, Types,
} from '../service/server';
import { ContestCodeHandler, ContestScoreboardHandler } from './contest';

const validatePenaltyRules = (input: string) => yaml.load(input);
const convertPenaltyRules = validatePenaltyRules;

class HomeworkMainHandler extends Handler {
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, group = '', page = 1) {
        const groups = (await user.listGroup(domainId, this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) ? undefined : this.user._id))
            .map((i) => i.name);
        if (group && !groups.includes(group)) throw new NotAssignedError(group);
        const cursor = contest.getMulti(domainId, {
            rule: 'homework',
            ...this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) && !group
                ? {}
                : {
                    $or: [
                        { maintainer: this.user._id },
                        { owner: this.user._id },
                        { assign: { $in: groups } },
                        { assign: { $size: 0 } },
                    ],
                },
            ...group ? { assign: { $in: [group] } } : {},
        }).sort({
            penaltySince: -1, endAt: -1, beginAt: -1, _id: -1,
        });
        const [tdocs, tpcount] = await this.paginate(cursor, page, 'contest');
        const calendar = [];
        for (const tdoc of tdocs) {
            const cal = { ...tdoc, url: this.url('homework_detail', { tid: tdoc.docId }) };
            if (contest.isExtended(tdoc) || contest.isDone(tdoc)) {
                cal.endAt = tdoc.endAt;
                cal.penaltySince = tdoc.penaltySince;
            } else cal.endAt = tdoc.penaltySince;
            calendar.push(cal);
        }
        const qs = group ? `group=${group}` : '';
        const groupsFilter = groups.filter((i) => !Number.isSafeInteger(+i));
        this.response.body = {
            tdocs, calendar, tpcount, page, qs, groups: groupsFilter, group,
        };
        this.response.template = 'homework_main.html';
    }
}

class HomeworkDetailHandler extends Handler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        if (tdoc.assign?.length && !this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            if (!Set.intersection(tdoc.assign, this.user.group).size) {
                throw new NotAssignedError('homework', tdoc.docId);
            }
        }
    }

    @param('tid', Types.ObjectId)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, tid: ObjectId, page = 1) {
        const [tdoc, tsdoc] = await Promise.all([
            contest.get(domainId, tid),
            contest.getStatus(domainId, tid, this.user._id),
        ]);
        if (tdoc.rule !== 'homework') throw new ContestNotFoundError(domainId, tid);
        // discussion
        const [ddocs, dpcount, dcount] = await this.paginate(
            discussion.getMulti(domainId, { parentType: tdoc.docType, parentId: tdoc.docId }),
            page,
            'discussion',
        );
        const uids = ddocs.map((ddoc) => ddoc.owner);
        uids.push(tdoc.owner);
        const udict = await user.getList(domainId, uids);
        this.response.template = 'homework_detail.html';
        this.response.body = {
            tdoc, tsdoc, udict, ddocs, page, dpcount, dcount,
        };
        this.response.body.tdoc.content = this.response.body.tdoc.content
            .replace(/\(file:\/\//g, `(./${tdoc.docId}/file/`)
            .replace(/="file:\/\//g, `="./${tdoc.docId}/file/`);
        if (
            (contest.isNotStarted(tdoc) || (!tsdoc?.attend && !contest.isDone(tdoc)))
            && !this.user.own(tdoc)
            && !this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
        ) return;
        const pdict = await problem.getList(domainId, tdoc.pids, true, true, problem.PROJECTION_CONTEST_LIST);
        const psdict = {};
        let rdict = {};
        if (tsdoc) {
            if (tsdoc.attend && !tsdoc.startAt && contest.isOngoing(tdoc)) {
                await contest.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
                tsdoc.startAt = new Date();
            }
            for (const pdetail of tsdoc.journal || []) {
                psdict[pdetail.pid] = pdetail;
                rdict[pdetail.rid] = { _id: pdetail.rid };
            }
            if (contest.canShowSelfRecord.call(this, tdoc) && tsdoc.journal) {
                rdict = await record.getList(
                    domainId,
                    tsdoc.journal.map((pdetail) => pdetail.rid),
                );
            }
        }
        Object.assign(this.response.body, { pdict, psdict, rdict });
    }

    @param('tid', Types.ObjectId)
    async postAttend(domainId: string, tid: ObjectId) {
        this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        const tdoc = await contest.get(domainId, tid);
        if (contest.isDone(tdoc)) throw new HomeworkNotLiveError(tdoc.docId);
        await contest.attend(domainId, tdoc.docId, this.user._id);
        this.back();
    }
}

class HomeworkEditHandler extends Handler {
    @param('tid', Types.ObjectId, true)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = tid ? await contest.get(domainId, tid) : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const extensionDays = tid
            ? Math.round(
                (tdoc.endAt.getTime() - tdoc.penaltySince.getTime()) / (Time.day / 100),
            ) / 100
            : 0;
        const beginAt = tid
            ? moment(tdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);
        const penaltySince = tid
            ? moment(tdoc.penaltySince).tz(this.user.timeZone)
            : beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);
        this.response.template = 'homework_edit.html';
        this.response.body = {
            tdoc,
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            datePenaltyText: penaltySince.format('YYYY-M-D'),
            timePenaltyText: penaltySince.format('H:mm'),
            extensionDays,
            penaltyRules: tid ? yaml.dump(tdoc.penaltyRules) : null,
            pids: tid ? tdoc.pids.join(',') : '',
            page_name: tid ? 'homework_edit' : 'homework_create',
        };
    }

    @param('tid', Types.ObjectId, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('penaltySinceDate', Types.Date)
    @param('penaltySinceTime', Types.Time)
    @param('extensionDays', Types.Float)
    @param('penaltyRules', Types.Content, validatePenaltyRules, convertPenaltyRules)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('pids', Types.Content)
    @param('rated', Types.Boolean)
    @param('maintainer', Types.NumericArray, true)
    @param('assign', Types.CommaSeperatedArray, true)
    async postUpdate(
        domainId: string, tid: ObjectId, beginAtDate: string, beginAtTime: string,
        penaltySinceDate: string, penaltySinceTime: string, extensionDays: number,
        penaltyRules: PenaltyRules, title: string, content: string, _pids: string, rated = false,
        maintainer: number[] = [], assign: string[] = [],
    ) {
        const pids = _pids.replace(/，/g, ',').split(',').map((i) => +i).filter((i) => i);
        const tdoc = tid ? await contest.get(domainId, tid) : null;
        if (!tid) this.checkPerm(PERM.PERM_CREATE_HOMEWORK);
        else if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');
        const penaltySince = moment.tz(`${penaltySinceDate} ${penaltySinceTime}`, this.user.timeZone);
        if (!penaltySince.isValid()) throw new ValidationError('endAtDate', 'endAtTime');
        const endAt = penaltySince.clone().add(extensionDays, 'days');
        if (beginAt.isSameOrAfter(penaltySince)) throw new ValidationError('endAtDate', 'endAtTime');
        if (penaltySince.isAfter(endAt)) throw new ValidationError('extensionDays');
        await problem.getList(domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id, true);
        if (!tid) {
            tid = await contest.add(domainId, title, content, this.user._id,
                'homework', beginAt.toDate(), endAt.toDate(), pids, rated,
                { penaltySince: penaltySince.toDate(), penaltyRules, assign });
        } else {
            await contest.edit(domainId, tid, {
                title,
                content,
                beginAt: beginAt.toDate(),
                endAt: endAt.toDate(),
                pids,
                penaltySince: penaltySince.toDate(),
                penaltyRules,
                rated,
                maintainer,
                assign,
            });
            if (tdoc.beginAt !== beginAt.toDate()
                || tdoc.endAt !== endAt.toDate()
                || tdoc.penaltySince !== penaltySince.toDate()
                || tdoc.pids.sort().join(' ') !== pids.sort().join(' ')) {
                await contest.recalcStatus(domainId, tdoc.docId);
            }
        }
        this.response.body = { tid };
        this.response.redirect = this.url('homework_detail', { tid });
    }

    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        await Promise.all([
            record.updateMulti(domainId, { domainId, contest: tid }, undefined, undefined, { contest: '' }),
            contest.del(domainId, tid),
            storage.del(tdoc.files?.map((i) => `contest/${domainId}/${tid}/${i.name}`) || [], this.user._id),
        ]);
        this.response.redirect = this.url('homework_main');
    }
}

export class HomeworkFilesHandler extends Handler {
    tdoc: Tdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await contest.get(domainId, tid);
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        else this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        this.response.body = {
            tdoc: this.tdoc,
            tsdoc: await contest.getStatus(domainId, this.tdoc.docId, this.user._id),
            udoc: await user.getById(domainId, this.tdoc.owner),
            files: sortFiles(this.tdoc.files || []),
            urlForFile: (filename: string) => this.url('homework_file_download', { tid, filename }),
        };
        this.response.pjax = 'partials/files.html';
        this.response.template = 'homework_files.html';
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        if ((this.tdoc.files?.length || 0) >= system.get('limit.contest_files')) {
            throw new FileLimitExceededError('count');
        }
        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');
        const f = statSync(file.filepath);
        const size = Math.sum((this.tdoc.files || []).map((i) => i.size)) + f.size;
        if (size >= system.get('limit.contest_files_size')) {
            throw new FileLimitExceededError('size');
        }
        await storage.put(`contest/${domainId}/${tid}/${filename}`, file.filepath, this.user._id);
        const meta = await storage.getMeta(`contest/${domainId}/${tid}/${filename}`);
        const payload = { _id: filename, name: filename, ...pick(meta, ['size', 'lastModified', 'etag']) };
        if (!meta) throw new FileUploadError();
        await contest.edit(domainId, tid, { files: [...(this.tdoc.files || []), payload] });
        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        await Promise.all([
            storage.del(files.map((t) => `contest/${domainId}/${tid}/${t}`), this.user._id),
            contest.edit(domainId, tid, { files: this.tdoc.files.filter((i) => !files.includes(i.name)) }),
        ]);
        this.back();
    }
}

export class HomeworkFileDownloadHandler extends Handler {
    @param('tid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, tid: ObjectId, filename: string, noDisposition = false) {
        this.response.addHeader('Cache-Control', 'public');
        const target = `contest/${domainId}/${tid}/${filename}`;
        const file = await storage.getMeta(target);
        await oplog.log(this, 'download.file.contest', {
            target,
            size: file?.size || 0,
        });
        this.response.redirect = await storage.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export async function apply(ctx) {
    ctx.Route('homework_main', '/homework', HomeworkMainHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_create', '/homework/create', HomeworkEditHandler);
    ctx.Route('homework_detail', '/homework/:tid', HomeworkDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_scoreboard', '/homework/:tid/scoreboard', ContestScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    ctx.Route(
        'homework_scoreboard_download', '/homework/:tid/scoreboard/download/:ext',
        ContestScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD,
    );
    ctx.Route('homework_code', '/homework/:tid/code', ContestCodeHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_edit', '/homework/:tid/edit', HomeworkEditHandler);
    ctx.Route('homework_files', '/homework/:tid/file', HomeworkFilesHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('homework_file_download', '/homework/:tid/file/:filename', HomeworkFileDownloadHandler, PERM.PERM_VIEW_HOMEWORK);
}
