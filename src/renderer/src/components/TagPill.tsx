import { useSettings } from "@renderer/contexts/SettingsContext";
import { useTags } from "@renderer/contexts/TagsContext";
import { DbTagCategory, DbTagWithCategory } from "@renderer/shared/types/types";
import { useState, useRef, useEffect } from "react";

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

  const { showTagCategoryNames } = useSettings();
  const { allCategories, updateTag } = useTags();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
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
        className={`flex items-center gap-1 px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-300 text-xs group ${className}`}
        onContextMenu={handleContextMenu}
      >
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