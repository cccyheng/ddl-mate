import { isValidDateKey, shanghaiToday } from './datetime'
import { validateWallClockInput } from './wallClockInput'
import { emptyTaskDraft, type TaskDraft } from './types'

export interface ExamPhotoRow {
  key: number; selected: boolean; title: string; date: string; start: string; end: string
  location: string; seat: string; courseId: number | null; warning: string
}
export const MAX_EXAM_PHOTO_ROWS = 20
export function parseExamPhotoText(text: string, today = shanghaiToday()): ExamPhotoRow[] {
  if(text.length>10000) throw new Error('识别文字过长，请分图导入。')
  const cards=[...text.matchAll(/【考试\s*\d+】([\s\S]*?)【结束】/g)]
  if(cards.length>MAX_EXAM_PHOTO_ROWS)throw new Error('单次最多导入 20 场考试，请分图。')
  return cards.map((match,index)=>{
    const lines=match[1]!.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)
    const dateText=lines.find(x=>/考试.*期/.test(x))??''
    const dateMatch=dateText.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/)
    const date=dateMatch?`${dateMatch[1]}-${dateMatch[2]!.padStart(2,'0')}-${dateMatch[3]!.padStart(2,'0')}`:''
    const times=lines.find(x=>x.startsWith('时间栏'))??''
    const values=[...times.matchAll(/(?<!\d)([01]?\d|2[0-3])[:：.]([0-5]\d)(?!\d)/g)].map(x=>`${x[1]!.padStart(2,'0')}:${x[2]}`)
    const rangeValid=values.length===2&&values[1]!>values[0]!
    const content=lines.filter(x=>!/(考试.*期|座位|时间栏)/.test(x))
    const title=content[0]??'', location=content.slice(1).join(' ')
    const seat=(lines.find(x=>/座位/.test(x))??'').match(/[:：]\s*([\w-]+)/)?.[1]??''
    const validDate=isValidDateKey(date),past=validDate&&date<today
    return {key:index+1,selected:!!title&&validDate&&!past,title,date:validDate?date:'',start:rangeValid?values[0]!:'',end:rangeValid?values[1]!:'',location,seat,courseId:null,
      warning:[!rangeValid?'时间未读清，请补选或保留仅日期。':'',!validDate?'日期未读清，请补选。':'',past?'已过期，默认不勾选。':''].filter(Boolean).join(' ')}
  })
}

export function examPhotoTaskDraft(row: ExamPhotoRow, sourceText: string): TaskDraft {
  if(!Number.isSafeInteger(row.key)||row.key<1||row.key>1000)throw new Error('考试候选编号无效。')
  if(!row.title.trim()||row.title.length>200)throw new Error('请填写考试名称，最多 200 字。')
  if(!row.date)throw new Error('请填写考试日期。')
  const error=validateWallClockInput(row.date,row.start,{allowDateOnly:true})
  if(error)throw new Error(error)
  if(row.end&&(!row.start||validateWallClockInput(row.date,row.end)||row.end<=row.start))throw new Error('结束时间必须晚于开始时间；不确定可留空。')
  if(row.location.length>500||row.seat.length>50)throw new Error('地点或座位号过长，请核对。')
  return {...emptyTaskDraft(),type:'EXAM',title:row.title.trim(),courseId:row.courseId,
    deadline:row.start?`${row.date}T${row.start}`:row.date,
    description:[row.location?`考试地点：${row.location}`:'',row.seat?`座位号：${row.seat}`:'',row.start?`考试时间：${row.start}${row.end?`–${row.end}`:''}`:'考试时间：仅日期，具体时刻未设置'].filter(Boolean).join('\n'),originalText:sourceText}
}
