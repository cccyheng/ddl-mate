/**
 * Tesseract 识别参数（浏览器与 Node 冒烟脚本共用，保证两条路径行为一致）。
 *
 * tessedit_pageseg_mode = 11（SPARSE_TEXT）：
 *   课表照片是"稀疏文本 + 表格"版面，默认的 6（统一文本块）会把同一行里不同列的
 *   文字合并成一行（例如"高等数学 数据结构"），导致无法按列拆课。
 *   实测同一张表格样图：PSM 6 置信度 75 且相邻两门课被合并；PSM 11 置信度 91，
 *   每个单元格独立成行、表头星期也各自带 bbox，可以按列还原。
 *
 * preserve_interword_spaces = 1：保留词间空格，便于按列定位与课程名切分。
 */
export const TESSERACT_PARAMS = {
  tessedit_pageseg_mode: '11',
  preserve_interword_spaces: '1',
}

/** 若 PSM 11 什么都没识别出来，退回 auto(3) 再试一次。 */
export const TESSERACT_FALLBACK_PARAMS = {
  tessedit_pageseg_mode: '3',
  preserve_interword_spaces: '1',
}
