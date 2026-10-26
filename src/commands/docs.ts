import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Command } from "commander";

import type { HubClient } from "../core/client.js";
import type { Deps, FileAccess } from "../core/runtime.js";
import { CliError, validationError } from "../core/errors.js";
import { readLocalFile, writeLocalFile } from "../core/files.js";
import { action, requireValue } from "../core/runtime.js";

/**
 * The document library: plans, scripts and notes in Markdown or HTML. These
 * are the Hub's own REST endpoints (`/api/hub/v1/documents`), not Kan's. The
 * Hub keeps no files: every document is text, so it travels as JSON.
 *
 * Reading, creating and editing work from the CLI, and so does choosing who can
 * read a document (`doc +share`, the web app's 谁能看). Deleting a document and
 * handing out edit rights stay in the web app on purpose: an API key has no
 * scope yet (docs/DESIGN.md), so a leaked key must not be able to remove files
 * or pass on the right to change them.
 */

const hub = "hub" as const;

/** Who can read a document: every member, 指定的人, or only its editors. */
type Audience = "all" | "selected" | "editors";

/** A document's 指定的人; the Hub only shows them to people who can change them. */
interface ReaderList {
  users: { userId: string; name: string }[];
  groups: { projectPublicId: string; departmentPublicId: string | null; label: string }[];
}

interface DocSummary {
  publicId: string;
  title: string;
  description?: string | null;
  filename: string;
  ext: string;
  size: number;
  folderPublicId?: string | null;
  readable: boolean;
  audience?: Audience;
  readers?: ReaderList | null;
  canEdit?: boolean;
  updatedAt?: string;
}

/** Everyone and everything 指定的人 can name, from `GET /documents/audience-options`. */
interface AudienceOptions {
  departments: { publicId: string; name: string }[];
  projects: {
    publicId: string;
    name: string;
    members: { userId: string; name: string }[];
    departments: { publicId: string; memberIds: string[] }[];
  }[];
}

type ReaderGroup = { projectPublicId: string; departmentPublicId: string | null };

interface Folder {
  publicId: string;
  name: string;
  parentPublicId?: string | null;
}

/** The only formats the Hub holds. */
const FORMATS = new Set(["md", "html", "htm"]);

const extensionOf = (filename: string) => extname(filename).slice(1).toLowerCase();

function requireFormat(filename: string, flag: string) {
  if (FORMATS.has(extensionOf(filename))) return;
  throw validationError(
    `${filename}：Hub 的文档只有 Markdown（.md）和 HTML（.html）两种`,
    flag,
    "Word（.docx）请在网页「文档」页的「上传文件」里传，会自动转成 Markdown；PDF、PPT 不收。",
  );
}

const nodeFiles: FileAccess = { readFile, writeFile };

const docView = (doc: DocSummary) => ({
  publicId: doc.publicId,
  title: doc.title,
  filename: doc.filename,
  size: doc.size,
  folder: doc.folderPublicId ?? null,
  readable: doc.readable,
  audience: doc.audience ?? null,
  canEdit: doc.canEdit ?? null,
  updatedAt: doc.updatedAt ?? null,
  ...(doc.description ? { description: doc.description } : {}),
});

const documentPath = (publicId: string, tail = "") => `/documents/${encodeURIComponent(publicId)}${tail}`;

const collect = (value: string, previous: string[]) => [...previous, value];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** One person among everyone 指定的人 can name, by userId or by name. */
function resolveReader(options: AudienceOptions, who: string): string {
  const people = new Map<string, string>();
  for (const project of options.projects) {
    for (const member of project.members) people.set(member.userId, member.name);
  }
  if (people.has(who.trim())) return who.trim();
  const named = [...people].filter(([, name]) => same(name, who));
  if (named.length === 1) return named[0]![0];
  if (named.length > 1) {
    throw new CliError({
      type: "conflict",
      subtype: "ambiguous_reader",
      message: `「${who}」对上了不止一个人`,
      hint: `改用 userId：${named.map(([userId, name]) => `${name} ${userId}`).join("、")}`,
    });
  }
  throw new CliError({
    type: "not_found",
    subtype: "unknown_reader",
    message: `能选的人里没有「${who}」`,
    hint: "--reader 要写名字或 userId；bshub doc audience-options 列出所有能选的人。",
  });
}

/**
 * One project or department by publicId, or by a name that only one of them
 * has. Sharing with the wrong group would open the document to the wrong
 * people, so a name two of them share is refused rather than guessed.
 */
function pickOne<T extends { publicId: string; name: string }>(
  items: T[],
  which: string,
  kind: { noun: string; subtype: string },
): T {
  const byId = items.find((item) => item.publicId === which.trim());
  if (byId) return byId;
  const named = items.filter((item) => same(item.name, which));
  if (named.length === 1) return named[0]!;
  const listed = (list: T[]) => list.map((item) => `${item.name}（${item.publicId}）`).join("、");
  if (named.length > 1) {
    throw new CliError({
      type: "conflict",
      subtype: `ambiguous_${kind.subtype}`,
      message: `叫「${which}」的${kind.noun}不止一个`,
      hint: `改用 publicId：${listed(named)}`,
    });
  }
  throw new CliError({
    type: "not_found",
    subtype: `unknown_${kind.subtype}`,
    message: `没有「${which}」这个${kind.noun}`,
    hint: `${kind.noun}：${listed(items) || "（没有）"}`,
  });
}

const resolveProject = (options: AudienceOptions, which: string) =>
  pickOne(options.projects, which, { noun: "项目", subtype: "project" });

/** `项目/部门`, each by publicId or name, e.g. "BuilderSpace 社团/运营". */
function resolveDepartment(options: AudienceOptions, spec: string): ReaderGroup {
  const cut = spec.lastIndexOf("/");
  if (cut <= 0 || cut === spec.length - 1) {
    throw validationError(`--department 要写成「项目/部门」：${spec}`, "department", "例如 --department \"BuilderSpace 社团/运营\"。");
  }
  const project = resolveProject(options, spec.slice(0, cut));
  const department = pickOne(options.departments, spec.slice(cut + 1), { noun: "部门", subtype: "department" });
  return { projectPublicId: project.publicId, departmentPublicId: department.publicId };
}

/** The Hub answered, but not with the audience that was asked for (an older Hub ignores it). */
function audienceNotApplied(publicId: string, wanted: Audience, got: DocSummary) {
  return new CliError({
    type: "api",
    subtype: "audience_not_applied",
    message: `文档 ${publicId} 没能改成想要的可见范围（要 ${wanted}，现在是 ${got.audience ?? (got.readable ? "all" : "editors")}）`,
    hint: "Hub 可能还不支持指定读者。在网页的「谁能看」里设置，或升级 Hub 后重试。",
  });
}

interface ContentFlags {
  file?: string;
  text?: string;
  stdin?: boolean;
}

/** Where a document's content comes from: exactly one of --file, --text, --stdin. */
async function readContent(deps: Deps, flags: ContentFlags, filenameFlag: string | undefined, fallbackName: string) {
  const given = [flags.file, flags.text, flags.stdin].filter((value) => value !== undefined && value !== false);
  if (given.length !== 1) {
    throw validationError("内容要从 --file、--text、--stdin 里选一个", "file");
  }
  const files = deps.files ?? nodeFiles;

  if (flags.file !== undefined) {
    const filename = filenameFlag ?? basename(flags.file);
    return { filename, bytes: await readLocalFile(files, flags.file) };
  }
  const text = flags.text !== undefined ? flags.text : await deps.readStdin();
  return { filename: filenameFlag ?? fallbackName, bytes: new TextEncoder().encode(text) };
}

const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function textOrFail(bytes: Uint8Array, filename: string): string {
  try {
    return utf8(bytes);
  } catch {
    throw validationError(`${filename} 不是 UTF-8 文本`, "file", "文本格式的文档请先转成 UTF-8。");
  }
}

/** A document that was meant to be private but came back readable by everyone. */
function notPrivate(publicId: string) {
  return new CliError({
    type: "api",
    subtype: "not_private",
    message: `文档 ${publicId} 没能设成仅管理者可见，它现在对所有登录的人可见`,
    hint: `马上在网页里把它设为不可读，或运行 bshub doc +update ${publicId} --private。`,
  });
}

/** Creates the document, then makes sure a private one really is private. */
async function createDocument(
  client: HubClient,
  input: {
    title: string;
    description?: string;
    folder?: string;
    readable: boolean;
    filename: string;
    bytes: Uint8Array;
  },
): Promise<DocSummary> {
  const common = {
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.folder ? { folderPublicId: input.folder } : {}),
    readable: input.readable,
  };

  const created = await client.request<DocSummary>({
    method: "POST",
    root: hub,
    path: "/documents",
    body: { ...common, filename: input.filename, content: textOrFail(input.bytes, input.filename) },
  });

  if (!input.readable && created.readable !== false) {
    // An older Hub may ignore the flag. Close the gap now rather than trust it.
    const fixed = await client.request<DocSummary>({
      method: "PATCH",
      root: hub,
      path: documentPath(created.publicId),
      body: { readable: false },
    });
    if (fixed.readable !== false) throw notPrivate(created.publicId);
    return fixed;
  }
  return created;
}

export function registerDocs(program: Command, deps: Deps, exit: { code: number }) {
  const doc = program.command("doc").description("文档库：Markdown 和 HTML 写的方案、讲稿、笔记。带 + 的是快捷命令");

  doc
    .command("list")
    .description("一个文件夹里的文档和子文件夹（不指定就是最上层），或搜索结果")
    .option("--folder <publicId>", "文件夹的 publicId")
    .option("--search <text>", "按标题搜索")
    .action(
      action<{ folder?: string; search?: string }>(deps, exit, async (runtime, _args, options) => {
        const result = await (await runtime.client()).request<{ folders?: Folder[]; documents: DocSummary[] }>({
          method: "GET",
          root: hub,
          path: "/documents",
          query: { folder: options.folder, search: options.search },
        });
        const documents = result.documents.map(docView);
        return {
          data: { folders: result.folders ?? [], documents },
          meta: { count: documents.length },
        };
      }),
    );

  doc
    .command("get")
    .description("一份文档的详情（不含内容，看内容用 cat）")
    .argument("<publicId>", "文档的 publicId")
    .action(
      action(deps, exit, async (runtime, args) => {
        const detail = await (await runtime.client()).request<DocSummary>({
          method: "GET",
          root: hub,
          path: documentPath(requireValue(args[0], "<publicId>")),
        });
        return { data: { ...docView(detail), ...(detail.readers ? { readers: detail.readers } : {}) } };
      }),
    );

  doc
    .command("cat")
    .description("一份文档（md / html）的内容")
    .argument("<publicId>", "文档的 publicId")
    .action(
      action(deps, exit, async (runtime, args) => {
        const publicId = requireValue(args[0], "<publicId>");
        const result = await (await runtime.client()).request<{ content: string; updatedAt?: string }>({
          method: "GET",
          root: hub,
          path: documentPath(publicId, "/content"),
        });
        return { data: { publicId, content: result.content, updatedAt: result.updatedAt ?? null } };
      }),
    );

  doc
    .command("+create")
    .description("新建文档（Markdown 或 HTML）：内容从 --file / --text / --stdin 来")
    .requiredOption("--title <title>", "标题")
    .option("--file <path>", "本地文件")
    .option("--text <text>", "直接给文本内容（文件名默认是「标题.md」，可用 --filename 改）")
    .option("--stdin", "从标准输入读文本内容")
    .option("--filename <name>", "文件名，决定格式，例如 讲稿.md；用 --file 时默认取文件本身的名字")
    .option("--description <text>", "说明")
    .option("--folder <publicId>", "放进哪个文件夹（默认最上层）")
    .option("--private", "不可读：只有所有者和编辑者看得到（默认所有登录的人都能读）")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{
        title: string;
        file?: string;
        text?: string;
        stdin?: boolean;
        filename?: string;
        description?: string;
        folder?: string;
        private?: boolean;
        dryRun?: boolean;
      }>(deps, exit, async (runtime, _args, options) => {
        const title = requireValue(options.title.trim(), "--title");
        const { filename, bytes } = await readContent(deps, options, options.filename, `${title.replace(/[\\/]/g, "-")}.md`);
        requireFormat(filename, options.file !== undefined && options.filename === undefined ? "file" : "filename");
        const client = await runtime.client();
        const readable = !options.private;

        if (options.dryRun) {
          const common = {
            title,
            ...(options.description ? { description: options.description } : {}),
            ...(options.folder ? { folderPublicId: options.folder } : {}),
            readable,
          };
          const data = [
            client.describe({
              method: "POST",
              root: hub,
              path: "/documents",
              body: { ...common, filename, content: textOrFail(bytes, filename) },
            }),
          ];
          return { data, meta: { dryRun: true } };
        }
        const created = await createDocument(client, {
          title,
          description: options.description,
          folder: options.folder,
          readable,
          filename,
          bytes,
        });
        return { data: docView(created) };
      }),
    );

  doc
    .command("+update")
    .description("改标题、说明、文件夹、可读性，或换掉文本内容")
    .argument("<publicId>", "文档的 publicId")
    .option("--title <title>", "新标题")
    .option("--description <text>", "新说明")
    .option("--folder <publicId>", "移到这个文件夹")
    .option("--private", "设为不可读")
    .option("--public", "设为所有登录的人可读")
    .option("--file <path>", "用这个文件（.md / .html）的内容替换")
    .option("--text <text>", "用这段文本替换")
    .option("--stdin", "用标准输入的文本替换")
    .option("--if-unmodified-since <updatedAt>", "替换内容时：只有文档的更新时间还是这个值才保存（用 doc cat 拿到的 updatedAt），否则报冲突，避免覆盖别人的修改")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{
        title?: string;
        description?: string;
        folder?: string;
        private?: boolean;
        public?: boolean;
        file?: string;
        text?: string;
        stdin?: boolean;
        ifUnmodifiedSince?: string;
        dryRun?: boolean;
      }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<publicId>");
        if (options.ifUnmodifiedSince && options.file === undefined && options.text === undefined && !options.stdin) {
          throw validationError("--if-unmodified-since 只在替换内容时有意义", "if-unmodified-since");
        }
        if (options.private && options.public) throw validationError("--private 和 --public 二选一", "private");

        const patch = {
          ...(options.title !== undefined ? { title: requireValue(options.title.trim(), "--title") } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.folder !== undefined ? { folderPublicId: options.folder } : {}),
          ...(options.private ? { readable: false } : {}),
          ...(options.public ? { readable: true } : {}),
        };
        const replacing = options.file !== undefined || options.text !== undefined || options.stdin;
        if (options.ifUnmodifiedSince && Object.keys(patch).length > 0) {
          // Changing details advances the document's update time, which would make the check fail against our own change.
          throw validationError(
            "--if-unmodified-since 不能和 --title / --description / --folder / --private / --public 一起用",
            "if-unmodified-since",
            "先改信息，再用 doc cat 重新拿 updatedAt，单独替换内容。",
          );
        }
        if (Object.keys(patch).length === 0 && !replacing) {
          throw validationError("没有要改的内容：给至少一个 --title / --description / --folder / --private / --public / 内容来源", "title");
        }

        const client = await runtime.client();
        const contentBody = (text: string) => ({
          content: text,
          ...(options.ifUnmodifiedSince ? { expectedUpdatedAt: options.ifUnmodifiedSince } : {}),
        });
        let content: string | undefined;
        if (replacing) {
          const read = await readContent(deps, options, undefined, "内容.md");
          if (options.file !== undefined) requireFormat(read.filename, "file");
          content = textOrFail(read.bytes, read.filename);
        }

        // The order matters for exposure. Going private happens first, so new
        // text is never written into a document that is still readable by
        // everyone. Anything else writes the content first and the visibility
        // last, so a half-finished update never makes a document public.
        const patching = Object.keys(patch).length > 0;
        const privateFirst = patch.readable === false;
        const steps = [
          ...(patching ? [{ name: "patch" as const, spec: { method: "PATCH" as const, root: hub, path: documentPath(publicId), body: patch } }] : []),
          ...(content !== undefined
            ? [{ name: "content" as const, spec: { method: "PUT" as const, root: hub, path: documentPath(publicId, "/content"), body: contentBody(content) } }]
            : []),
        ];
        if (!privateFirst) steps.reverse();

        if (options.dryRun) {
          return { data: steps.map((step) => client.describe(step.spec)), meta: { dryRun: true } };
        }

        let updated: DocSummary | undefined;
        for (const step of steps) {
          if (step.name === "content") {
            await client.request(step.spec);
            updated = undefined; // size and updatedAt changed: read it again below
            continue;
          }
          updated = await client.request<DocSummary>(step.spec);
          // Never write new text into a document that was meant to go private
          // but is still readable: check before the content step runs.
          if (patch.readable === false && updated.readable !== false) throw notPrivate(publicId);
        }
        updated ??= await client.request<DocSummary>({ method: "GET", root: hub, path: documentPath(publicId) });
        return { data: { ...docView(updated), ...(content !== undefined ? { contentReplaced: true } : {}) } };
      }),
    );

  doc
    .command("+download")
    .description("把一份文档的内容存到本地文件")
    .argument("<publicId>", "文档的 publicId")
    .requiredOption("--out <path>", "保存到哪里")
    .option("--dry-run", "只打印将要发出的请求，不下载、不写本地文件")
    .action(
      action<{ out: string; dryRun?: boolean }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<publicId>");
        const client = await runtime.client();
        const detailSpec = { method: "GET" as const, root: hub, path: documentPath(publicId) };
        const contentSpec = { method: "GET" as const, root: hub, path: documentPath(publicId, "/content") };
        if (options.dryRun) {
          return {
            data: [
              client.describe(detailSpec),
              client.describe(contentSpec),
              { note: `把内容写到 ${options.out}（已有同名文件会被覆盖）` },
            ],
            meta: { dryRun: true },
          };
        }
        const detail = await client.request<DocSummary>(detailSpec);
        const { content } = await client.request<{ content: string }>(contentSpec);
        const bytes = new TextEncoder().encode(content);
        await writeLocalFile(deps.files ?? nodeFiles, options.out, bytes);
        return { data: { publicId, filename: detail.filename, out: options.out, size: bytes.byteLength } };
      }),
    );

  doc
    .command("audience-options")
    .description("设置谁能看时能选的人、项目和部门（userId 和 publicId 在这里看）")
    .action(
      action(deps, exit, async (runtime) => {
        const options = await (await runtime.client()).request<AudienceOptions>({
          method: "GET",
          root: hub,
          path: "/documents/audience-options",
        });
        const departmentName = new Map(options.departments.map((d) => [d.publicId, d.name]));
        return {
          data: {
            departments: options.departments,
            projects: options.projects.map((project) => ({
              publicId: project.publicId,
              name: project.name,
              members: project.members,
              departments: project.departments
                .filter((d) => d.memberIds.length > 0)
                .map((d) => ({ publicId: d.publicId, name: departmentName.get(d.publicId) ?? d.publicId, memberIds: d.memberIds })),
            })),
          },
        };
      }),
    );

  doc
    .command("+share")
    .description("设置谁能看：所有成员、指定的人（人、项目、部门），或只有能编辑的人")
    .argument("<publicId>", "文档的 publicId")
    .option("--everyone", "所有登录的成员都能读")
    .option("--editors-only", "只有所有者和能编辑的人能读")
    .option("--reader <who>", "指定的人：名字或 userId，可重复", collect, [] as string[])
    .option("--project <which>", "指定整个项目：publicId 或项目名，可重复", collect, [] as string[])
    .option("--department <项目/部门>", "指定项目里的一个部门，例如「BuilderSpace 社团/运营」，可重复", collect, [] as string[])
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{
        everyone?: boolean;
        editorsOnly?: boolean;
        reader: string[];
        project: string[];
        department: string[];
        dryRun?: boolean;
      }>(deps, exit, async (runtime, args, options) => {
        const publicId = requireValue(args[0], "<publicId>");
        const selecting = options.reader.length + options.project.length + options.department.length > 0;
        const modes = [options.everyone, options.editorsOnly, selecting].filter(Boolean).length;
        if (modes !== 1) {
          throw validationError(
            "谁能看要从 --everyone、--editors-only、指定的人（--reader / --project / --department）里选一种",
            "everyone",
          );
        }
        const client = await runtime.client();

        let audience: { kind: Audience; userIds?: string[]; groups?: ReaderGroup[] };
        if (options.everyone) audience = { kind: "all" };
        else if (options.editorsOnly) audience = { kind: "editors" };
        else {
          const choices = await client.request<AudienceOptions>({ method: "GET", root: hub, path: "/documents/audience-options" });
          const wholeProjects = [...new Set(options.project.map((which) => resolveProject(choices, which).publicId))];
          // A department of a project chosen as a whole is already in it; the Hub drops it too.
          const departments = options.department
            .map((spec) => resolveDepartment(choices, spec))
            .filter((group) => !wholeProjects.includes(group.projectPublicId));
          audience = {
            kind: "selected",
            userIds: [...new Set(options.reader.map((who) => resolveReader(choices, who)))],
            groups: [...wholeProjects.map((projectPublicId) => ({ projectPublicId, departmentPublicId: null })), ...departments],
          };
        }

        const spec = { method: "PATCH" as const, root: hub, path: documentPath(publicId), body: { audience } };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };

        const updated = await client.request<DocSummary>(spec);
        // An older Hub drops `audience` it does not know and answers 200 anyway;
        // the document must not be left readable by more people than asked for.
        const readers = updated.readers;
        const missing = [
          ...(audience.userIds ?? []).filter((id) => !readers?.users.some((user) => user.userId === id)),
          ...(audience.groups ?? []).filter(
            (group) =>
              !readers?.groups.some(
                (g) => g.projectPublicId === group.projectPublicId && g.departmentPublicId === group.departmentPublicId,
              ),
          ),
        ];
        if (updated.audience !== audience.kind || missing.length > 0) {
          throw audienceNotApplied(publicId, audience.kind, updated);
        }
        return { data: { ...docView(updated), ...(updated.readers ? { readers: updated.readers } : {}) } };
      }),
    );

  doc
    .command("folder")
    .description("文件夹")
    .command("+create")
    .description("新建文件夹")
    .requiredOption("--name <name>", "文件夹名")
    .option("--parent <publicId>", "放在哪个文件夹里（默认最上层，最多三层）")
    .option("--dry-run", "只打印将要发出的请求")
    .action(
      action<{ name: string; parent?: string; dryRun?: boolean }>(deps, exit, async (runtime, _args, options) => {
        const client = await runtime.client();
        const spec = {
          method: "POST" as const,
          root: hub,
          path: "/documents/folders",
          body: { name: requireValue(options.name.trim(), "--name"), ...(options.parent ? { parentPublicId: options.parent } : {}) },
        };
        if (options.dryRun) return { data: client.describe(spec), meta: { dryRun: true } };
        return { data: await client.request<Folder>(spec) };
      }),
    );
}
