# 测试用例执行器

基于 Flask + openpyxl 的轻量 Web 工具，将 Excel 测试用例变为可交互的执行界面，支持逐条浏览、标记结果、实时回写原文件。

## 功能特性

- 自动解析多 Sheet 工作簿，跳过统计汇总页和分组标题行
- 单条大卡片展示：前置条件、测试步骤、预期结果、示意图
- 按模块筛选 / 跳转下一条未测用例
- 标记 PASS / FAIL / BLOCK，填写实际现象与发现时间
- 执行结果原子写回原始 xlsx（自动备份，不怕丢数据）
- 实时进度条统计
- 支持上传其他 xlsx 文件并下载回写后的版本

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 启动（默认加载工作区内的 多机测试用例_合并版.xlsx）
python app.py
```

浏览器打开 http://127.0.0.1:5000 即可使用。

## 项目结构

```
├── app.py              # Flask 入口与 API 路由
├── excel_service.py    # Excel 解析 / 写回核心逻辑
├── requirements.txt    # Python 依赖
├── static/
│   ├── index.html      # 前端单页
│   ├── app.js          # 前端交互逻辑
│   └── style.css       # 样式
└── uploads/            # 上传文件 & 自动备份（运行时生成）
```

## Excel 格式要求

工作簿需满足：

- 首列为「用例编号」的表头行（前 5 行内自动识别）
- 14 列标准结构：用例编号 / 功能模块 / 场景 / 标题 / 前置条件 / 测试步骤 / 预期结果 / 优先级 / 风险等级 / 测试结果 / BugID / 测试人员 / 备注 / 示意图
- 名为「统计汇总」的 Sheet 会被自动跳过
- 仅用例编号和预期结果均非空的行视为有效用例

## 技术栈

- 后端：Python / Flask / openpyxl
- 前端：原生 HTML + CSS + JavaScript（无框架依赖）
- 写回策略：临时文件 + `os.replace` 原子替换，线程锁防并发
