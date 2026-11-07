import { useSettings } from "@renderer/contexts/SettingsContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { DbTagCategory, DbTagWithCategory } from "@renderer/shared/types/types";
import { useState, useRef, useEffect } from "react";
import { PRESET_COLORS, PRESET_ICONS } from "./TagManagerView";

// TagPill.tsx
interface TagPillProps {
  tag: DbTagWithCategory;
  onRemove?: () => void;   // renders × button when present
  applied: boolean;
  onAdd?: () => void;      // renders + prefix when present
  /** Inherited (from the folder, or implied by another tag): dimmed, and
   *  can't be removed here. */
  inherited?: boolean;
  /** With `inherited`: the tag implying it. Absent: from the folder. */
  inheritedVia?: string;
  className?: string;
}

export function TagPill({ tag, onRemove, applied, onAdd, inherited, inheritedVia, className }: TagPillProps) {
  const color = tag.category?.color ?? "#888";
  const icon = tag.category?.icon ?? "●";

  const { showTagCategoryNames } = useSettings();
  const { allCategories, updateTag, refreshTags } = useTags();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCreateCategory = async (name: string) => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return;

    // Reuse an existing category instead of re-randomizing its color/icon.
    const existing = allCategories.find((c) => c.name === trimmed);
    if (existing) {
      await handleCategorySelect(existing.id);
      setNewCategoryName("");
      return;
    }

    const color = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
    const icon = PRESET_ICONS[Math.floor(Math.random() * PRESET_ICONS.length)];

    const newCategory = await window.api.createTagCategory(trimmed, color, icon);
    await refreshTags();
    await handleCategorySelect(newCategory.id);
    setNewCategoryName("");
};

  const getMenuPosition = () => {
    if (!contextMenu) return {};
    
    const menuHeight = 220; // max-h-[220px]
    const menuWidth = 160; // min-w-[160px]
    const padding = 8;
    
    const spaceBelow = window.innerHeight - contextMenu.y;
    const spaceRight = window.innerWidth - contextMenu.x;
    
    const position: React.CSSProperties = {};
    
    // Vertical positioning
    if (spaceBelow < menuHeight + padding) {
      position.bottom = window.innerHeight - contextMenu.y + padding;
    } else {
      position.top = contextMenu.y;
    }
    
    // Horizontal positioning - sliding scale
    const distanceFromRight = window.innerWidth - contextMenu.x;
    const centerThreshold = menuWidth + padding *6; // generous space for centering
    
    if (distanceFromRight > centerThreshold) {
      // Plenty of space - go right
      position.left = contextMenu.x;
    } else if (spaceRight < (menuWidth * .75)) {
      // Too close to edge - go left
      position.right = window.innerWidth - contextMenu.x;
    } else {
      // Some space - go center
      console.log("went center")
      position.left = contextMenu.x - menuWidth / 2;
    }
    
    return position;
  };

  const handleCategorySelect = async (categoryId: number | null) => {
    updateTag(tag.id, tag.name, categoryId);
    setContextMenu(null);
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleResize = () => {
      if (menuRef.current) {
        setContextMenu(null);
      }
    }

    if (contextMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      window.addEventListener('resize', handleResize);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        window.removeEventListener('resize', handleResize);
      }
    }
  }, [contextMenu]);

  return (
    <>
      <span
        className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300 text-xs group ${
          applied ? "border border-neutral-500" : ""
        } ${inherited ? "opacity-50" : ""} ${className}`}
        title={
          !inherited
            ? undefined
            : inheritedVia
              ? `Comes with "${inheritedVia}". Remove "${inheritedVia}" to take it off.`
              : "From the folder's tags. Remove it there to take it off."
        }
        onContextMenu={handleContextMenu}
      >
        {tag.category && !showTagCategoryNames && (
          <span className="text-[10px] leading-none flex-shrink-0" style={{ color }}>
            {icon}
          </span>
        )}
        <button
          onClick={onAdd ?? onRemove}
          className={`text-left transition-colors ${inherited ? "cursor-default" : "hover:text-neutral-100"}`}
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

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed bg-neutral-900 border border-neutral-700 rounded-md shadow-lg py-1 z-50 min-w-[160px] max-h-[220px] overflow-y-auto"
          style={getMenuPosition()}
        >
          <button
            onClick={() => handleCategorySelect(null)}
            className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            <span className="text-neutral-500">No category</span>
          </button>
          <div className="border-t border-neutral-700 my-1" />
<div className="flex items-center gap-1 px-2 py-1">
    <input
        value={newCategoryName}
        onChange={(e) => setNewCategoryName(e.target.value)}
        onKeyDown={(e) => {
    e.stopPropagation();
    if (e.key === "Enter") handleCreateCategory(newCategoryName);
}}
        placeholder="New category…"
        className="flex-1 px-1.5 py-0.5 text-xs bg-neutral-800 border border-neutral-700 rounded text-neutral-200 placeholder-neutral-600 outline-none"
    />
    <button
        onMouseDown={(e) => {
    e.preventDefault();
    handleCreateCategory(newCategoryName);
}}
        className="text-neutral-400 hover:text-neutral-100 transition-colors text-sm leading-none px-1"
    >
        +
    </button>
</div>
          {allCategories.map((category: DbTagCategory) => (
            <button
              key={category.id}
              onClick={() => handleCategorySelect(category.id)}
              className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 transition-colors flex items-center gap-2"
            >
              <span style={{ color: category.color }}>{category.icon}</span>
              <span>{category.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}