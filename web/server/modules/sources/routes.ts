import { createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { AppError } from "../../platform/errors.ts";
import {
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  Page,
  unix,
} from "../../platform/http.ts";
import {
  College,
  CollegeInput,
  CollegePatch,
  CollegeQuery,
  PageQuery,
  ProbeInput,
  RunSummary,
  School,
  SchoolInput,
  SchoolPatch,
  Source,
  SourceDetail,
  SourceInput,
  SourceProbe,
  SourcePatch,
  SourceQuery,
  PublicCollegeDetail,
  PublicCollegeList,
  LOGO_MAX_BYTES,
  LOGO_TYPES,
} from "./schemas.ts";
import {
  createCollege,
  createSchool,
  createProbe,
  createSource,
  getCollege,
  getProbe,
  getSchool,
  getSource,
  latestRuns,
  listColleges,
  listSchools,
  listSources,
  updateCollege,
  updateSchool,
  updateSource,
  getPublicCollege,
  listPublicColleges,
  getLogo,
  setLogo,
  removeLogo,
} from "./service.ts";

const errors = {
  400: errorResponse("请求格式有误"),
  401: errorResponse("没有登录"),
  403: errorResponse("只有管理员能操作"),
  404: errorResponse("学校、学院或来源不存在"),
  409: errorResponse("名称或网址重复"),
};
function json<T extends z.ZodType>(schema: T) {
  return { "application/json": { schema } };
}

const image = Object.fromEntries(
  LOGO_TYPES.map((type) => [type, { schema: z.string().openapi({ format: "binary" }) }]),
);

const router = createRouter();
router.use(
  "/admin/schools/:id/logo",
  bodyLimit({
    maxSize: LOGO_MAX_BYTES,
    onError() {
      throw new AppError(413, "too_large", `校徽不能超过 ${LOGO_MAX_BYTES / 1024} KB`);
    },
  }),
);

export const sourcesRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/schools/{id}/logo",
      summary: "校徽",
      description:
        "人人都能看。地址里的 v 是最后修改的时间，图片换了地址就变，所以浏览器可以一直缓存",
      request: { params: IdParam },
      responses: {
        200: { description: "校徽图片", content: image },
        400: errorResponse("学校编号格式有误"),
        404: errorResponse("该学校没有校徽"),
      },
    }),
    async (c) => {
      const logo = await getLogo(c.req.valid("param").id);
      return c.body(new Uint8Array(logo.data), 200, {
        "Content-Type": logo.content_type,
        "Cache-Control": "public, max-age=31536000, immutable",
        // An SVG opened on its own could run scripts; this keeps it a picture.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/admin/schools/{id}/logo",
      summary: "上传或更换校徽",
      description: `请求体就是图片本身，Content-Type 写它的类型：PNG、JPEG、WebP 或 SVG，不超过 ${LOGO_MAX_BYTES / 1024} KB`,
      request: { params: IdParam, body: { required: true, content: image } },
      responses: {
        204: { description: "已保存" },
        ...errors,
        413: errorResponse("图片太大"),
      },
    }),
    async (c) => {
      const admin = authorize(c, "admin");
      const declared = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();
      const type = LOGO_TYPES.find((item) => item === declared);
      if (!type)
        throw new AppError(400, "invalid_request", "校徽只能是 PNG、JPEG、WebP 或 SVG 图片");
      const data = Buffer.from(await c.req.arrayBuffer());
      if (data.length === 0) throw new AppError(400, "invalid_request", "请选择校徽图片");
      await setLogo({ user_id: admin.id, via: "web" }, c.req.valid("param").id, {
        content_type: type,
        data,
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/schools/{id}/logo",
      summary: "移除校徽",
      request: { params: IdParam },
      responses: { 204: { description: "已移除" }, ...errors },
    }),
    async (c) => {
      await removeLogo({ user_id: authorize(c, "admin").id, via: "web" }, c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/colleges",
      summary: "院校清单",
      request: {},
      responses: {
        200: { description: "按学校分组的学院清单", content: json(PublicCollegeList) },
        401: errorResponse("没有登录"),
        403: errorResponse("账号已冻结"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await listPublicColleges(), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/colleges/{id}",
      summary: "学院详情",
      request: { params: IdParam },
      responses: {
        200: { description: "学院、来源和历年项目", content: json(PublicCollegeDetail) },
        400: errorResponse("学院编号格式有误"),
        401: errorResponse("没有登录"),
        403: errorResponse("账号已冻结"),
        404: errorResponse("学院不存在"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json(await getPublicCollege(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/schools",
      summary: "管理学校清单",
      request: { query: PageQuery },
      responses: { 200: { description: "学校清单", content: json(Page(School)) }, ...errors },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await listSchools(c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/schools/{id}",
      summary: "学校详情",
      request: { params: IdParam },
      responses: { 200: { description: "学校", content: json(School) }, ...errors },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await getSchool(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/schools",
      summary: "新增学校",
      request: { body: { required: true, content: json(SchoolInput) } },
      responses: { 201: { description: "已新增", content: json(School) }, ...errors },
    }),
    async (c) => {
      const row = await createSchool(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      return c.json(row, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/schools/{id}",
      summary: "修改学校",
      request: { params: IdParam, body: { required: true, content: json(SchoolPatch) } },
      responses: { 200: { description: "已修改", content: json(School) }, ...errors },
    }),
    async (c) =>
      c.json(
        await updateSchool(
          { user_id: authorize(c, "admin").id, via: "web" },
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/colleges",
      summary: "管理学院清单",
      request: { query: CollegeQuery },
      responses: { 200: { description: "学院清单", content: json(Page(College)) }, ...errors },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await listColleges(c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/colleges/{id}",
      summary: "学院详情",
      request: { params: IdParam },
      responses: { 200: { description: "学院", content: json(College) }, ...errors },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await getCollege(c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/colleges",
      summary: "新增学院",
      request: { body: { required: true, content: json(CollegeInput) } },
      responses: { 201: { description: "已新增", content: json(College) }, ...errors },
    }),
    async (c) => {
      const id = await createCollege(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      return c.json(await getCollege(id), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/colleges/{id}",
      summary: "修改学院",
      request: { params: IdParam, body: { required: true, content: json(CollegePatch) } },
      responses: { 200: { description: "已修改", content: json(College) }, ...errors },
    }),
    async (c) => {
      const id = await updateCollege(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(await getCollege(id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/sources",
      summary: "管理来源清单",
      request: { query: SourceQuery },
      responses: {
        200: {
          description: "来源及最近抓取摘要",
          content: json(Page(Source.extend({ last_run: RunSummary.nullable() }))),
        },
        ...errors,
      },
    }),
    async (c) => {
      authorize(c, "admin");
      const page = await listSources(c.req.valid("query"));
      const runs = await latestRuns(page.items.map((s) => s.id));
      return c.json(
        {
          ...page,
          items: page.items.map((s) => ({
            ...s,
            crawled_at: s.crawled_at ? unix(s.crawled_at) : null,
            last_run: runs.find((r) => r.source_id === s.id) ?? null,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/sources/{id}",
      summary: "来源配置详情",
      request: { params: IdParam },
      responses: { 200: { description: "来源详情", content: json(SourceDetail) }, ...errors },
    }),
    async (c) => {
      authorize(c, "admin");
      const source = await getSource(c.req.valid("param").id);
      return c.json(
        { ...source, crawled_at: source.crawled_at ? unix(source.crawled_at) : null },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/sources",
      summary: "接入来源",
      request: { body: { required: true, content: json(SourceInput) } },
      responses: { 201: { description: "已接入", content: json(SourceDetail) }, ...errors },
    }),
    async (c) => {
      const id = await createSource(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      const source = await getSource(id);
      return c.json(
        { ...source, crawled_at: source.crawled_at ? unix(source.crawled_at) : null },
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/sources/{id}",
      summary: "修改来源、暂停或恢复抓取",
      request: { params: IdParam, body: { required: true, content: json(SourcePatch) } },
      responses: { 200: { description: "已修改", content: json(SourceDetail) }, ...errors },
    }),
    async (c) => {
      const id = await updateSource(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      const source = await getSource(id);
      return c.json(
        { ...source, crawled_at: source.crawled_at ? unix(source.crawled_at) : null },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/source-probes",
      summary: "发起试抓",
      description: "抓取节点下一次领活时领到它，交回抓到的条目和生成的配置（总体设计 §7.2）。",
      request: { body: { required: true, content: json(ProbeInput) } },
      responses: {
        201: { description: "已发起", content: json(z.object({ id: Int })) },
        400: errors[400],
        401: errors[401],
        403: errors[403],
      },
    }),
    async (c) => {
      const id = await createProbe(
        { user_id: authorize(c, "admin").id, via: "web" },
        c.req.valid("json"),
      );
      return c.json({ id }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/source-probes/{id}",
      summary: "试抓的结果",
      request: { params: IdParam },
      responses: {
        200: { description: "试抓", content: json(SourceProbe) },
        400: errors[400],
        401: errors[401],
        403: errors[403],
        404: errorResponse("试抓不存在"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json(await getProbe(c.req.valid("param").id), 200);
    },
  );
