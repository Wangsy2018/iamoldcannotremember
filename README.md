# AI 日程

## 👉 [点这里打开 AI 日程](https://wangsy2018.github.io/iamoldcannotremember/)

https://wangsy2018.github.io/iamoldcannotremember/

手机上用 Chrome 打开后：「⋮」→「安装应用」→「安装」，桌面就有图标了。

---

一句话（打字或语音）建日程和待办，写进 Google 日历 / Google Tasks，按「日常 / 工作 / 重要」分类，带月历视图。

- `docs/`：网页 App（PWA），由 GitHub Pages 发布，可安装到手机桌面
- `apps-script/`：后台，放在 Google Apps Script 上，负责调用 DeepSeek 和读写日历

仓库里没有任何密钥：DeepSeek key 和 App 密码都存在 Apps Script 的「脚本属性」里。

## 后台（Apps Script）

脚本属性：
- `DEEPSEEK_API_KEY`：必填
- `DEEPSEEK_MODEL`：可选，默认 `deepseek-chat`
- `APP_TOKEN`：App 密码。在编辑器里选 `setupToken` 运行一次自动生成，执行日志里会显示

部署：Web 应用，执行身份「我」，有权访问的人员「任何人」。后台只认带正确 App 密码的请求，其他请求一律拒绝。

改代码后：「部署」→「管理部署」→ 铅笔 → 版本选「新版本」→「部署」，网址不变。

## 网页 App（docs/）

- 后台网址写在 `docs/app.js` 顶部的 `API`
- 改了界面后，把 `docs/sw.js` 里的 `CACHE` 版本号加一，手机上才会更新
- 手机：Chrome 打开网址 →「⋮」→「安装应用」/「添加到主屏幕」

## 会议邮件截图

- 点输入框旁的 📷 选截图（可多选）；电脑上截图后在页面里直接 Ctrl/⌘+V
- 后台用 Google 云端硬盘的文字识别读出文字（临时文件用完即删），再交给 DeepSeek 解析
- Zoom / Teams / Meet 链接以截图原文为准，写进日程的「地点」和备注，手机提醒通知里能看到；日程旁有「进入会议」按钮
- 需要 Apps Script 里开启「Drive API」服务

## 分类

- 每个分类对应一个同名 Google 日历和同名待办清单，第一次用到时自动创建
- 改分类名或颜色：改 `apps-script/Code.gs` 顶部的 `CATEGORIES`
- 其他日历（主日历、节假日等）里的事项统一显示为灰色「其他」

## 已知限制

- Google Tasks 的接口不能设提醒时间，所以带时间或要提醒的事都建成日历事件
- 没有内置语音按钮，想说话就用输入法自带的麦克风
- 安卓网页 App 不能做桌面小组件
