import type { Edge, Node, Viewport } from "@xyflow/react";

export type MediaKind = "image" | "video";
export type Scenario = "canvas" | "drama";
// 新后端统一状态：queued/running/succeeded/failed/uncertain/cancelled
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled";

export type VideoNodeData = {
  name: string;
  originalPrompt: string;
  inheritEnabled: boolean;
  kind?: MediaKind;
  resultUrl?: string;
  taskStatus?: TaskStatus;
  size?: string;
  model?: string;
  referenceAssetId?: string | null;
  pendingRequestId?: string | null;
  /** 短剧：镜号，例如 1、2A */
  shotNumber?: string;
  /** 短剧：人工采用状态，不由模型成功事件自动设置 */
  adopted?: boolean;
  /** 视频：分辨率 */
  videoResolution?: string;
  /** 视频：画幅 */
  videoRatio?: string;
  /** 视频：时长（秒） */
  videoDuration?: number;
};

export type VideoNode = Node<VideoNodeData, "video" | "image">;
export type VideoEdge = Edge;

export type CanvasSnapshot = {
  nodes: VideoNode[];
  edges: VideoEdge[];
  viewport: Viewport;
};

export type Sku = {
  id: string;
  name: string;
  assetIds: string[];
};

export type Character = {
  id: string;
  name: string;
  description: string;
  assetIds: string[];
};

export type CanvasProject = CanvasSnapshot & {
  id: string;
  name: string;
  cover?: string;
  fitOnOpen: boolean;
  scenario: Scenario;
  /** 短剧：已粘贴脚本原文 */
  script: string;
  /** 创作参考说明 */
  referenceDescription: string;
  /** 仅兼容历史数据，不再提供 SKU 功能 */
  skus: Sku[];
  /** 短剧：角色卡列表 */
  characters: Character[];
};

export type AssetKind = "upload" | "generated" | "edited" | "video";

export type Asset = {
  id: string;
  name: string;
  kind: AssetKind;
  url: string;
  projectId?: string;
  nodeId?: string;
  taskId?: string;
  model?: string;
  ext: "png" | "jpg" | "webp" | "mp4";
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sourceAssetId?: string;
  editParams?: string | null;
  createdAt: string;
};

export type ImageTask = {
  id: string;
  projectId: string;
  nodeId: string;
  nodeName: string;
  scenario: string;
  status: TaskStatus;
  error?: string;
  resultUrl?: string;
  assetId?: string;
  width?: number;
  height?: number;
  providerTaskId?: string;
  estimatedCost: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  sentAt?: string;
  finishedAt?: string;
  durationMs?: number;
  snapshot: {
    kind: "image" | "video";
    finalText: string;
    templateVersion: string;
    nodeRawPrompt: string;
    inheritEnabled: boolean;
    predecessorNodeId?: string;
    predecessorName?: string;
    predecessorRawPrompt?: string;
    model: string;
    size: string;
    n: number;
    mode: "real";
    referenceAssetId?: string | null;
    referenceMode: string;
    videoParams?: { resolution: string; ratio: string; duration: number };
  };
};

export type QueueSummary = {
  paused: boolean;
  concurrency: number;
  running: number;
  queued: number;
  estimatedSpent: number;
  reserved: number;
  budgetLimit: number;
};

export type Settings = {
  configured: boolean;
  provider: string;
  models: string[];
  model: string;
  price: number;
  video: {
    baseUrl: string;
    model: string;
    keyConfigured: boolean;
    configured: boolean;
    verified: boolean;
  };
} & QueueSummary;
