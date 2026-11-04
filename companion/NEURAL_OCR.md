# 本地中文地点校对

表格几何、课程、序号和周次仍由现有解析链路处理。可选的 PP-OCRv5 模型按单元格逐行识别中文地点，再按完整序号与格内记录顺序配对。它不会用中文模型粘连的数字覆盖周次，也不会自动写入课程数据库。

图片与裁剪内容只通过本机子进程标准输入传递，不发送网络、不落临时图片文件。ONNX Runtime 遥测关闭。每次请求最多 1000 行，60 秒超时；取消或超时会终止子进程。模型不可用时返回基础识别及核对提示。

## 准备与运行

需要 Python 3.12（64 位）。执行 `companion/scripts/setup-neural-ocr.ps1 -PythonPath <python.exe 的绝对路径>`。准备脚本把包和模型放进项目 `.tools/neural-ocr`，不会修改 Expo、Node 或全局 Python 依赖。已有 Python 环境含 NumPy/Pillow 时也可单独准备私有 onnxruntime，并写入 `config.json` 的 `python` 路径。

配置后重启伴侣服务。启动只读取本地文件，绝不会自动下载或安装。删除配置即可回到基础识别；无需更改手机数据。模型路径及 Python 路径不会在手机 API 返回。

## 固定版本与来源

- CPU runtime：Microsoft `onnxruntime==1.23.2`，来自 [PyPI 官方包](https://pypi.org/project/onnxruntime/1.23.2/)，MIT 许可证保留在私有 runtime 包中。
- 模型：RapidAI PP-OCRv5 中文 mobile rec，来源 [RapidOCR 官方模型清单](https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml)，固定下载版本 `v3.10.0`。
- 下载地址：`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx`。
- SHA-256：`5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5`，启动时校验。
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) / [RapidOCR](https://github.com/RapidAI/RapidOCR)：Apache-2.0。本项目自行实现行裁剪、标准 CTC 解码和流程集成；未复制第三方识别器源码。

仍须在导入页核对。低置信度、无法配对或不含地点结构的读数不会覆盖原结果；缺条不会借用另一周的地点。
