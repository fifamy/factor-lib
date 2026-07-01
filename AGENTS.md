# 项目规则

- 生成或修改Word文档（`.docx`）时，输出文档内的正文、标题、表格、目录说明、附录等所有可控文本样式统一使用宋体。
- 对已生成Word文档的样式、标题、目录说明、附录增删等产物级修改，优先直接编辑现有`.docx`并做轻量校验；除非用户明确要求重生成文档或修改生成逻辑，不要默认走完整脚本重生成流程。

# 因子库常驻信息

- 线上页面地址：https://fifamy.github.io/factor-lib/
- GitHub Pages 仓库：`https://github.com/fifamy/factor-lib.git`，分支 `main`。
- 当前本地项目目录本身不是 git 仓库；当前用于 Pages 发布的有效工作副本在 `/private/tmp/factor-lib-pages-publish-20260701/repo`，远端指向 `fifamy/factor-lib`。
- 旧发布目录 `/private/tmp/factor-lib-pages-publish-120d/repo` 的 `.git` 曾出现缺少 `HEAD/config` 的损坏状态，不要再作为正式发布工作副本使用。
- `frontend/scripts/deploy_to_pages.sh` 是旧 demo 脚本，目标是 `factor-lib-demo`，不要用它同步正式页面。
- 正式页面发布时，把 `frontend/index.html`、`frontend/app.js`、`frontend/styles.css`、`frontend/vendor`、`frontend/data` 同步到 `/private/tmp/factor-lib-pages-publish-20260701/repo`，替换 `index.html` 里的 `DEPLOY_VERSION` 为时间戳后提交并 `git push origin main`。
- Supabase 项目地址：https://tsyplhfshxzoduynzixk.supabase.co；前端匿名 key 在 `frontend/app.js` 的 `SUPABASE_ANON_KEY`。
- 重要维护记录看 `docs/2026-06-10_标签规则与发布避坑记录.md`。
