/**
 * بناء خادم MCP — الأدوات الخمس بصياغة عربية للنتائج وأوصاف إنجليزية دقيقة للعميل.
 * SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, runMerge, refreshTask } from "./generation";
import { listRecentTasks, getTask } from "./turso";
import { formatTaskReply, formatTaskSummary } from "./format";
import type { ProgressSink } from "./generation";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** استخراج progressToken من _meta وبناء مُرسِل التقدم */
function sinkFromExtra(extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined): ProgressSink {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) return { sendProgress: async () => {} };
  return {
    sendProgress: async (progress: number, total: number, message: string) => {
      try {
        await extra!.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, total, message },
        });
      } catch {
        // فشل إرسال الإشعار لا يوقف المهمة أبدًا
      }
    },
  };
}

/** isError مطلوبة للفشل الحقيقي فقط (المعطيات) — أخطاء المفاتيح لا تصل للعميل أبدًا */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  /* ------------------------- 1) generate_image ------------------------- */
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). Returns the ready image URL if finished within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image")
          .describe("Image model"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto")
          .describe("Image aspect ratio"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K").describe("Output resolution"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png").describe("Output image format"),
        wait_seconds: z.number().int().min(0).max(240).default(90).describe("How long to wait before returning the task_id"),
      },
    },
    async (args, extra) => {
      const sink = sinkFromExtra(extra);
      const input: Record<string, unknown> = {
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        background: args.background,
        output_format: args.output_format,
      };
      const { task, noKeysMessage, paramsError } = await runGeneration(
        { prompt: args.prompt, model: args.model, wait_seconds: args.wait_seconds },
        "image",
        input,
        sink
      );
      if (noKeysMessage) return textResult(noKeysMessage, true);
      if (paramsError || !task) return textResult(`❌ فشلت المهمة: ${paramsError ?? "معطيات غير صالحة"}`, true);
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  /* ------------------------- 2) generate_video ------------------------- */
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/SFX/music, optional image-to-video). Video takes minutes: short wait with live progress then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview")
          .describe("Video model"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto").describe("Video aspect ratio"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p").describe("Output resolution"),
        enable_audio: z.boolean().default(true).describe("Generate synchronized audio"),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25).describe("How long to wait before returning the task_id"),
      },
    },
    async (args, extra) => {
      const sink = sinkFromExtra(extra);
      const input: Record<string, unknown> = {
        aspect_ratio: args.aspect_ratio,
        resolution: args.resolution,
        enable_audio: args.enable_audio,
        duration: args.duration,
        ...(args.image_url ? { image_url: args.image_url } : {}),
      };
      const { task, noKeysMessage, paramsError } = await runGeneration(
        { prompt: args.prompt, model: args.model, wait_seconds: args.wait_seconds },
        "video",
        input,
        sink
      );
      if (noKeysMessage) return textResult(noKeysMessage, true);
      if (paramsError || !task) return textResult(`❌ فشلت المهمة: ${paramsError ?? "معطيات غير صالحة"}`, true);
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  /* ------------------------- 3) merge_videos ------------------------- */
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Concatenate several clips into ONE final video in the given order. Pass 'urls' (public direct video links — e.g. links returned by generate_video) or 'task_ids' (completed video generation tasks — their result URLs are merged in this order; ideal after generating several clips). Merging is usually quick: short wait with live progress then a merge task_id — track it with get_task. the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .describe("Public direct video URLs (http/https), 2-10 clips in merge order — the first clip starts the final video. More than 10 is rejected.")
          .optional(),
        task_ids: z
          .array(z.string())
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks (2-10) — their result URLs are merged in this order.")
          .optional(),
        wait_seconds: z.number().int().min(0).max(240).default(60).describe("How long to wait before returning the task_id"),
      },
    },
    async (args, extra) => {
      const sink = sinkFromExtra(extra);
      // التحقق الصارم هنا (لا minItems/maxItems في المخطط) حتى تظهر الرسائل العربية الصحيحة للعميل
      const total = (args.urls?.length ?? 0) + (args.task_ids?.length ?? 0);
      if (total > 10) {
        return textResult("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", true);
      }
      if (total < 2) {
        return textResult(
          "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
          true
        );
      }
      const { task, validationError } = await runMerge(
        { urls: args.urls, task_ids: args.task_ids, wait_seconds: args.wait_seconds },
        sink
      );
      if (validationError) return textResult(validationError, true);
      if (!task) return textResult("❌ فشلت مهمة الدمج لسبب غير معروف", true);
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  /* ---------------------------- 4) get_task ---------------------------- */
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and live-updates from the provider/merging service while processing). Poll it every ~10 seconds; when completed the result URLs are in the reply — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1).describe("The task_id returned by generate_image/generate_video/merge_videos"),
      },
    },
    async (args) => {
      const task = await refreshTask(args.task_id);
      if (!task) return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}`, true);
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  /* --------------------------- 5) list_media --------------------------- */
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional().describe("Filter by media type"),
        status: z.enum(["completed", "failed", "processing"]).optional().describe("Filter by status"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of tasks to return"),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      if (!tasks.length) {
        return textResult("لا توجد وسائط مخزنة بعد بهذه المرشحات. جرّب توليد صورة أو فيديو أولًا بـ generate_image / generate_video.");
      }
      return textResult(`آخر ${tasks.length} مهمة:\n${tasks.map(formatTaskSummary).join("\n")}`);
    }
  );

  return server;
}
