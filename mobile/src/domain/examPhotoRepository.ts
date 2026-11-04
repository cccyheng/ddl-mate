import type { SqliteDatabase } from '../db/types'
import { TaskRepository } from './taskRepository'
import { examPhotoTaskDraft, MAX_EXAM_PHOTO_ROWS, type ExamPhotoRow } from './examPhoto'
import { normalizeTaskDraft } from './taskDraft'

export interface ExamPhotoImportRequest { attemptId: number; sourceText: string; rows: readonly ExamPhotoRow[]; generation: number }
export interface ExamPhotoImportResult { committed: true; created: number[]; existing: number[] }
// Caller owns the shared AppStore queue and checks restore generation inside it.
export async function importExamPhoto(db: SqliteDatabase, tasks: TaskRepository, input: ExamPhotoImportRequest): Promise<ExamPhotoImportResult> {
  if(!Number.isSafeInteger(input.attemptId)||input.attemptId<1)throw new Error('请先保存原图，再导入考试。')
  if(typeof input.sourceText!=='string'||!input.sourceText.trim()||input.sourceText.length>10000)throw new Error('识别原文为空或过长。')
  if(!Array.isArray(input.rows)||input.rows.length>MAX_EXAM_PHOTO_ROWS)throw new Error('单次最多 20 场考试。')
  const rows=input.rows.filter(r=>r.selected)
  if(!rows.length)throw new Error('请至少勾选一场考试。')
  if(new Set(rows.map(r=>r.key)).size!==rows.length)throw new Error('候选编号重复，请重新核对。')
  const drafts=rows.map(r=>examPhotoTaskDraft(r,input.sourceText)), result: ExamPhotoImportResult={committed:true,created:[],existing:[]}
  await db.withTransactionAsync(async()=>{
    const photo=await db.getFirstAsync<{archived_path:string|null;status:string}>('SELECT archived_path,status FROM screenshot_attempts WHERE id=?;',[input.attemptId])
    if(!photo?.archived_path||photo.status==='ARCHIVE_FAILED')throw new Error('原图还没有保存成功，或已被移除。请返回重新保存原图。')
    for(let i=0;i<rows.length;i++) {
      const relation=`EXAM_PHOTO_${rows[i]!.key}`,draft=drafts[i]!,normalized=normalizeTaskDraft(draft)
      const previous=await db.getFirstAsync<{target_id:number}>('SELECT target_id FROM screenshot_refs WHERE attempt_id=? AND target_kind=\'TASK\' AND relation=? LIMIT 1;',[input.attemptId,relation])
      if(previous){result.existing.push(previous.target_id);continue}
      if(normalized.courseId!==null&&!await db.getFirstAsync('SELECT id FROM courses WHERE id=?;',[normalized.courseId]))throw new Error('选择的课程已不存在，请重新核对。')
      const duplicate=await db.getFirstAsync<{id:number}>('SELECT id FROM tasks WHERE type=\'EXAM\' AND title=? AND deadline=? LIMIT 1;',[normalized.title,normalized.deadline])
      const id=duplicate?.id??await tasks.createWithinTransaction(draft)
      if(duplicate)result.existing.push(id);else result.created.push(id)
      await db.runAsync('INSERT INTO screenshot_refs (attempt_id,target_kind,target_id,relation,created_at) VALUES (?,\'TASK\',?,?,?);',[input.attemptId,id,relation,new Date().toISOString()])
    }
  })
  return result
}
