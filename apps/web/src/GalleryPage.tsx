import {
  AlertTriangle,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  ImageIcon,
  Loader2,
  Maximize2,
  Palette,
  RotateCcw,
  Ruler,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SIZE_PRESETS,
  STYLE_PRESETS,
  type GalleryImageItem,
  type GalleryResponse,
  type StylePresetId
} from "@gpt-image-canvas/shared";

interface GalleryPageProps {
  onDeleted: (outputId: string) => void;
  onReuse: (item: GalleryImageItem) => void;
}

interface GalleryActionHandlers {
  onCopy: (item: GalleryImageItem) => void;
  onDelete: (item: GalleryImageItem) => void;
  onDownload: (item: GalleryImageItem) => void;
  onReuse: (item: GalleryImageItem) => void;
}

const stylePresetLabels: Record<StylePresetId, string> = {
  none: "无风格",
  photoreal: "真实摄影",
  product: "商业产品",
  illustration: "精致插画",
  poster: "海报视觉",
  avatar: "头像角色"
};

const sizePresetLabels: Record<string, string> = {
  "square-1k": "方形成图 1K",
  "poster-portrait": "竖版海报",
  "poster-landscape": "横版海报",
  "story-9-16": "竖屏故事",
  "video-16-9": "视频封面",
  "wide-2k": "宽屏展示 2K",
  "portrait-2k": "高清竖图 2K",
  "square-2k": "高清方图 2K",
  "wide-4k": "宽屏展示 4K"
};

export function GalleryPage({ onDeleted, onReuse }: GalleryPageProps) {
  const [items, setItems] = useState<GalleryImageItem[]>([]);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [selectedItem, setSelectedItem] = useState<GalleryImageItem | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<GalleryImageItem | null>(null);
  const [deletingOutputId, setDeletingOutputId] = useState<string | null>(null);
  const statusTimerRef = useRef<number | undefined>();

  useEffect(() => {
    const controller = new AbortController();

    async function loadGallery(): Promise<void> {
      setIsLoading(true);
      setError("");

      try {
        const response = await fetch("api/gallery", {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(await readGalleryError(response));
        }

        const body = (await response.json()) as GalleryResponse;
        if (!Array.isArray(body.items)) {
          throw new Error("Gallery 服务返回了无法识别的数据。");
        }

        if (!controller.signal.aborted) {
          setItems(body.items);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : "Gallery 加载失败。");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    void loadGallery();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!selectedItem && !pendingDeleteItem) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      if (pendingDeleteItem) {
        setPendingDeleteItem(null);
        return;
      }

      setSelectedItem(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pendingDeleteItem, selectedItem]);

  useEffect(() => {
    return () => {
      window.clearTimeout(statusTimerRef.current);
    };
  }, []);

  const filteredItems = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return items;
    }

    return items.filter((item) => normalizeSearchText(item.prompt).includes(normalizedQuery));
  }, [items, query]);
  const featuredItem = filteredItems[0] ?? null;
  const gridItems = featuredItem ? filteredItems.slice(1) : filteredItems;
  const actionHandlers: GalleryActionHandlers = {
    onCopy: (item) => void copyPrompt(item),
    onDelete: requestDelete,
    onDownload: downloadItem,
    onReuse
  };

  function showStatus(message: string): void {
    window.clearTimeout(statusTimerRef.current);
    setError("");
    setStatusMessage(message);
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage("");
    }, 3200);
  }

  function togglePrompt(outputId: string): void {
    setExpandedPrompts((current) => ({
      ...current,
      [outputId]: !current[outputId]
    }));
  }

  async function copyPrompt(item: GalleryImageItem): Promise<void> {
    try {
      await writeClipboardText(item.prompt);
      showStatus("已复制提示词。");
    } catch {
      setError("复制失败，请手动选择提示词。");
    }
  }

  function downloadItem(item: GalleryImageItem): void {
    window.open(`/api/assets/${encodeURIComponent(item.asset.id)}/download`, "_blank", "noopener,noreferrer");
    showStatus("已打开原图下载。");
  }

  function requestDelete(item: GalleryImageItem): void {
    setError("");
    setPendingDeleteItem(item);
  }

  async function deleteItem(item: GalleryImageItem): Promise<void> {
    setDeletingOutputId(item.outputId);
    setError("");

    try {
      const response = await fetch(`/api/gallery/${encodeURIComponent(item.outputId)}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error(await readGalleryError(response));
      }

      setItems((current) => current.filter((galleryItem) => galleryItem.outputId !== item.outputId));
      setSelectedItem((current) => (current?.outputId === item.outputId ? null : current));
      setPendingDeleteItem(null);
      onDeleted(item.outputId);
      showStatus("已从 Gallery 和生成历史移除。");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除失败，请重试。");
    } finally {
      setDeletingOutputId(null);
    }
  }

  return (
    <main className="gallery-page app-view" data-testid="gallery-page">
      <div className="gallery-page__inner">
        <header className="gallery-header">
          <div className="gallery-header__copy">
            <p className="gallery-kicker">
              <Sparkles className="size-3.5" aria-hidden="true" />
              Editorial Gallery
            </p>
            <h1>作品图库</h1>
            <p>{items.length} 张本地作品，按最新生成排序。</p>
          </div>
          <div className="gallery-search" role="search">
            <Search className="size-4" aria-hidden="true" />
            <input
              aria-label="搜索 Gallery 提示词"
              className="gallery-search__input"
              data-testid="gallery-search"
              id="gallery-search-input"
              name="gallery-search"
              placeholder="搜索提示词、主题或风格"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </header>

        {error ? (
          <div className="gallery-alert gallery-alert--error" data-testid="gallery-error" role="alert">
            <XCircle className="size-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : null}
        {statusMessage ? (
          <div className="gallery-alert gallery-alert--success" data-testid="gallery-message" role="status">
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
            <p>{statusMessage}</p>
          </div>
        ) : null}

        {isLoading ? (
          <div className="gallery-empty-state" data-testid="gallery-loading" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            <p>正在载入 Gallery...</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="gallery-empty-state" data-testid="gallery-empty">
            <ImageIcon className="size-7" aria-hidden="true" />
            <div>
              <p>{items.length === 0 ? "暂无作品" : "没有匹配结果"}</p>
              <span>{items.length === 0 ? "生成成功的图片会出现在这里。" : "换一个提示词关键词再试试。"}</span>
            </div>
          </div>
        ) : (
          <>
            {featuredItem ? (
              <FeaturedGalleryItem
                deleting={deletingOutputId === featuredItem.outputId}
                expanded={Boolean(expandedPrompts[featuredItem.outputId])}
                item={featuredItem}
                onOpen={setSelectedItem}
                onTogglePrompt={togglePrompt}
                {...actionHandlers}
              />
            ) : null}

            {gridItems.length > 0 ? (
              <div className="gallery-grid" data-testid="gallery-grid">
                {gridItems.map((item) => (
                  <GalleryCard
                    deleting={deletingOutputId === item.outputId}
                    expanded={Boolean(expandedPrompts[item.outputId])}
                    item={item}
                    key={item.outputId}
                    onOpen={setSelectedItem}
                    onTogglePrompt={togglePrompt}
                    {...actionHandlers}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {selectedItem ? (
        <GalleryDetailDialog
          deleting={deletingOutputId === selectedItem.outputId}
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onCopy={() => void copyPrompt(selectedItem)}
          onDelete={() => requestDelete(selectedItem)}
          onDownload={() => downloadItem(selectedItem)}
          onReuse={() => onReuse(selectedItem)}
        />
      ) : null}

      {pendingDeleteItem ? (
        <DeleteGalleryDialog
          deleting={deletingOutputId === pendingDeleteItem.outputId}
          item={pendingDeleteItem}
          onCancel={() => setPendingDeleteItem(null)}
          onConfirm={() => void deleteItem(pendingDeleteItem)}
        />
      ) : null}
    </main>
  );
}

function FeaturedGalleryItem({
  deleting,
  expanded,
  item,
  onCopy,
  onDelete,
  onDownload,
  onOpen,
  onReuse,
  onTogglePrompt
}: {
  deleting: boolean;
  expanded: boolean;
  item: GalleryImageItem;
  onOpen: (item: GalleryImageItem) => void;
  onTogglePrompt: (outputId: string) => void;
} & GalleryActionHandlers) {
  return (
    <article className="gallery-feature" data-testid="gallery-feature">
      <button
        aria-label={`打开最新作品详情：${promptExcerpt(item.prompt)}`}
        className="gallery-feature__image-button"
        type="button"
        onClick={() => onOpen(item)}
      >
        <img
          alt={item.prompt}
          className="gallery-feature__image"
          height={item.asset.height}
          src={assetPreviewUrl(item.asset.id, 1024)}
          width={item.asset.width}
        />
        <span className="gallery-feature__badge">Latest</span>
        <span className="gallery-card__zoom">
          <Maximize2 className="size-4" aria-hidden="true" />
        </span>
      </button>

      <div className="gallery-feature__body">
        <div>
          <p className="gallery-feature__eyebrow">最新生成</p>
          <h2>编辑台主图</h2>
        </div>
        <GalleryTags item={item} />
        <CollapsiblePrompt
          expanded={expanded}
          label="提示词"
          lines={4}
          text={item.prompt}
          onToggle={() => onTogglePrompt(item.outputId)}
        />
        <div className="gallery-feature__meta">
          <span>
            <Clock3 className="size-3.5" aria-hidden="true" />
            {formatCreatedTime(item.createdAt)}
          </span>
          <span>{item.outputFormat.toUpperCase()}</span>
          <span>{qualityLabel(item.quality)}</span>
        </div>
        <GalleryIconActions
          deleting={deleting}
          item={item}
          onCopy={onCopy}
          onDelete={onDelete}
          onDownload={onDownload}
          onReuse={onReuse}
        />
      </div>
    </article>
  );
}

function GalleryCard({
  deleting,
  expanded,
  item,
  onCopy,
  onDelete,
  onDownload,
  onOpen,
  onReuse,
  onTogglePrompt
}: {
  deleting: boolean;
  expanded: boolean;
  item: GalleryImageItem;
  onOpen: (item: GalleryImageItem) => void;
  onTogglePrompt: (outputId: string) => void;
} & GalleryActionHandlers) {
  return (
    <article className="gallery-card" data-testid="gallery-card">
      <button
        aria-label={`打开图片详情：${promptExcerpt(item.prompt)}`}
        className="gallery-card__image-button"
        type="button"
        onClick={() => onOpen(item)}
      >
        <img
          alt={item.prompt}
          className="gallery-card__image"
          height={item.asset.height}
          loading="lazy"
          src={assetPreviewUrl(item.asset.id, 512)}
          width={item.asset.width}
        />
        <span className="gallery-card__zoom">
          <Maximize2 className="size-4" aria-hidden="true" />
        </span>
      </button>

      <div className="gallery-card__body">
        <GalleryTags item={item} compact />
        <CollapsiblePrompt
          expanded={expanded}
          label="提示词"
          lines={2}
          text={item.prompt}
          onToggle={() => onTogglePrompt(item.outputId)}
        />
        <div className="gallery-card__footer">
          <span className="gallery-time-tag">
            <Clock3 className="size-3.5" aria-hidden="true" />
            {formatCreatedTime(item.createdAt)}
          </span>
          <GalleryIconActions
            deleting={deleting}
            item={item}
            onCopy={onCopy}
            onDelete={onDelete}
            onDownload={onDownload}
            onReuse={onReuse}
          />
        </div>
      </div>
    </article>
  );
}

function GalleryIconActions({
  deleting,
  item,
  onCopy,
  onDelete,
  onDownload,
  onReuse
}: {
  deleting: boolean;
  item: GalleryImageItem;
} & GalleryActionHandlers) {
  const excerpt = promptExcerpt(item.prompt);

  return (
    <div className="gallery-card__actions">
      <button
        aria-label={`复制提示词：${excerpt}`}
        className="gallery-icon-action"
        title="复制提示词"
        type="button"
        onClick={() => onCopy(item)}
      >
        <Copy className="size-4" aria-hidden="true" />
      </button>
      <button
        aria-label={`下载图片：${excerpt}`}
        className="gallery-icon-action"
        title="下载原图"
        type="button"
        onClick={() => onDownload(item)}
      >
        <Download className="size-4" aria-hidden="true" />
      </button>
      <button
        aria-label={`复用提示词：${excerpt}`}
        className="gallery-icon-action"
        title="复用到画布"
        type="button"
        onClick={() => onReuse(item)}
      >
        <RotateCcw className="size-4" aria-hidden="true" />
      </button>
      <button
        aria-label={`删除 Gallery 图片：${excerpt}`}
        className="gallery-icon-action gallery-icon-action--danger"
        disabled={deleting}
        title="从 Gallery 移除"
        type="button"
        onClick={() => onDelete(item)}
      >
        {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

function GalleryTags({ item, compact = false }: { item: GalleryImageItem; compact?: boolean }) {
  const styleLabel = styleTagLabel(item.presetId);
  const sizeLabel = sizeTagLabel(item);

  return (
    <div className="gallery-tags" data-compact={compact}>
      <span className="gallery-tag gallery-tag--mode">{modeLabel(item.mode)}</span>
      {styleLabel ? (
        <span className="gallery-tag gallery-tag--style">
          <Palette className="size-3.5" aria-hidden="true" />
          {styleLabel}
        </span>
      ) : null}
      <span className="gallery-tag gallery-tag--size">
        <Ruler className="size-3.5" aria-hidden="true" />
        {sizeLabel}
      </span>
    </div>
  );
}

function CollapsiblePrompt({
  expanded,
  label,
  lines,
  text,
  onToggle
}: {
  expanded: boolean;
  label: string;
  lines: 2 | 4 | 8;
  text: string;
  onToggle: () => void;
}) {
  return (
    <section className="gallery-prompt-block">
      <div className="gallery-prompt-heading">
        <h3 className="gallery-prompt-label">{label}</h3>
        <button
          aria-expanded={expanded}
          className="gallery-prompt-toggle"
          data-expanded={expanded}
          type="button"
          onClick={onToggle}
        >
          {expanded ? "收起" : "展开"}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className="gallery-prompt-text" data-expanded={expanded} data-lines={lines}>
        {text}
      </p>
    </section>
  );
}

function GalleryDetailDialog({
  deleting,
  item,
  onClose,
  onCopy,
  onDelete,
  onDownload,
  onReuse
}: {
  deleting: boolean;
  item: GalleryImageItem;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onReuse: () => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);

  return (
    <div className="gallery-modal-backdrop" data-testid="gallery-detail" role="presentation">
      <div aria-labelledby="gallery-detail-title" aria-modal="true" className="gallery-modal" role="dialog">
        <header className="gallery-modal__header">
          <div className="gallery-modal__title">
            <p>Gallery Detail</p>
            <h2 id="gallery-detail-title">图片详情</h2>
            <GalleryTags item={item} />
          </div>
          <button aria-label="关闭图片详情" className="gallery-icon-action gallery-modal__close" type="button" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="gallery-modal__body">
          <div className="gallery-modal__media">
            <img
              alt={item.prompt}
              className="gallery-modal__image"
              height={item.asset.height}
              src={item.asset.url}
              width={item.asset.width}
            />
          </div>

          <aside className="gallery-modal__copy">
            <div className="gallery-modal__meta">
              <span>
                <Clock3 className="size-3.5" aria-hidden="true" />
                {formatCreatedTime(item.createdAt)}
              </span>
              <span>{item.outputFormat.toUpperCase()}</span>
              <span>{qualityLabel(item.quality)}</span>
            </div>
            <CollapsiblePrompt
              expanded={promptExpanded}
              label="提示词"
              lines={8}
              text={item.prompt}
              onToggle={() => setPromptExpanded((current) => !current)}
            />
          </aside>
        </div>

        <footer className="gallery-modal__actions">
          <button className="secondary-action h-10" type="button" onClick={onCopy}>
            <Copy className="size-4" aria-hidden="true" />
            复制
          </button>
          <button className="secondary-action h-10" type="button" onClick={onDownload}>
            <Download className="size-4" aria-hidden="true" />
            下载
          </button>
          <button className="secondary-action h-10" type="button" onClick={onReuse}>
            <RotateCcw className="size-4" aria-hidden="true" />
            复用
          </button>
          <button className="secondary-action h-10 text-red-700 hover:text-red-800" disabled={deleting} type="button" onClick={onDelete}>
            {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
            移除
          </button>
        </footer>
      </div>
    </div>
  );
}

function DeleteGalleryDialog({
  deleting,
  item,
  onCancel,
  onConfirm
}: {
  deleting: boolean;
  item: GalleryImageItem;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="gallery-confirm-backdrop" data-testid="gallery-delete-dialog" role="presentation">
      <div
        aria-describedby="gallery-delete-description"
        aria-labelledby="gallery-delete-title"
        aria-modal="true"
        className="gallery-confirm"
        role="dialog"
      >
        <div className="gallery-confirm__icon">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </div>
        <div className="gallery-confirm__copy">
          <h2 id="gallery-delete-title">移除这张 Gallery 图片？</h2>
          <p id="gallery-delete-description">
            将从 Gallery 和生成历史移除“{promptExcerpt(item.prompt)}”。画布中的图片、本地文件和资产记录会保留。
          </p>
        </div>
        <div className="gallery-confirm__actions">
          <button className="secondary-action h-10" disabled={deleting} type="button" onClick={onCancel}>
            取消
          </button>
          <button className="danger-action h-10" disabled={deleting} type="button" onClick={onConfirm}>
            {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
            确认移除
          </button>
        </div>
      </div>
    </div>
  );
}

function assetPreviewUrl(assetId: string, width: number): string {
  return `/api/assets/${encodeURIComponent(assetId)}/preview?width=${width}`;
}

function modeLabel(mode: GalleryImageItem["mode"]): string {
  return mode === "edit" ? "参考图" : "文生图";
}

function styleTagLabel(presetId: string): string {
  if (presetId === "none") {
    return "";
  }

  const preset = STYLE_PRESETS.find((item) => item.id === presetId);
  return preset ? (stylePresetLabels[preset.id] ?? preset.label) : "";
}

function sizeTagLabel(item: GalleryImageItem): string {
  const preset = SIZE_PRESETS.find((sizePreset) => sizePreset.width === item.size.width && sizePreset.height === item.size.height);
  const presetLabel = preset ? (sizePresetLabels[preset.id] ?? preset.label) : "自定义";
  return `${presetLabel} · ${item.size.width} x ${item.size.height}`;
}

function qualityLabel(quality: GalleryImageItem["quality"]): string {
  switch (quality) {
    case "low":
      return "快速草稿";
    case "medium":
      return "标准";
    case "high":
      return "高质量";
    case "auto":
    default:
      return "自动质量";
  }
}

function promptExcerpt(promptValue: string): string {
  const compact = promptValue.replace(/\s+/gu, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 48)}...` : compact;
}

function formatCreatedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

async function readGalleryError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `${body.error.message}（HTTP ${response.status}）` : `请求失败，状态 ${response.status}。`;
  } catch {
    return `请求失败，状态 ${response.status}。`;
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.readOnly = true;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.append(textArea);
  textArea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command was not accepted.");
    }
  } finally {
    textArea.remove();
  }
}
