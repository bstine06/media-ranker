import { useSettings } from "@renderer/contexts/SettingsContext";
import { DbTagWithCategory } from "@renderer/shared/types/types";

// TagPill.tsx
interface TagPillProps {
  tag: DbTagWithCategory;
  onRemove?: () => void;   // renders × button when present
  onAdd?: () => void;      // renders + prefix when present
  className?: string;
}

export function TagPill({ tag, onRemove, onAdd, className }: TagPillProps) {
  const color = tag.category?.color ?? "#888";
  const icon = tag.category?.icon ?? "●";

  const {showTagCategoryNames} = useSettings();

  return (
    <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300 text-xs group ${className}`}>
      {tag.category && !showTagCategoryNames && (
        <span className="text-[10px] leading-none flex-shrink-0" style={{ color }}>
          {icon}
        </span>
      )}
      <button
        onClick={onAdd ?? onRemove}
        className="text-left hover:text-neutral-100 transition-colors"
      >
        {tag.name}
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          className="text-neutral-600 hover:text-neutral-300 transition-colors leading-none"
        >
          ×
        </button>
      )}
    </span>
  );
}