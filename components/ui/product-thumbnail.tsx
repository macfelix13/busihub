import { Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZE_CLASSES = {
  sm: "h-10 w-10",
  md: "h-14 w-14",
  lg: "h-20 w-20",
} as const;

const ICON_SIZE_CLASSES = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
} as const;

/**
 * A product/service's photo (migration 0046), or a plain fallback icon
 * when it has none — used on the Products list, the product detail page,
 * and the till grid/search results. `photoUrl` must already be a resolved
 * signed URL (or null), never a raw storage path — see
 * lib/storage/product-photos.ts.
 *
 * Always loading="lazy": on the till in particular this can mean dozens
 * of tiles in the DOM at once (migration 0046's file header) — the
 * browser only actually fetches a photo once its tile is about to be
 * seen, with zero extra code needed on the caller's part.
 */
export function ProductThumbnail({
  photoUrl,
  size = "md",
  className,
}: {
  photoUrl: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800",
        SIZE_CLASSES[size],
        className
      )}
    >
      {photoUrl ? (
        // A short-lived signed URL — a per-viewer, dynamic string
        // next/image's optimizer has no use for. Same plain <img>
        // precedent as the receipt page's business logo and the service
        // provider photo picker.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      ) : (
        <ImageIcon className={cn("text-neutral-400", ICON_SIZE_CLASSES[size])} aria-hidden="true" />
      )}
    </span>
  );
}