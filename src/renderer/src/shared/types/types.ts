export type View = "browse" | "compare" | "file" | "scroll" | "tag-manager";

export interface DbFile {
    id: number;
    content_hash: string;
    path: string;
    filename: string;
    media_type: "photo" | "gif" | "video";
    elo_score: number;
    comparison_count: number;
    date_indexed: string;
    mtime: number;
    size: number;
    status: "active" | "missing";
    missing_since: string | null;
    folder_id?: number | null;
}

export interface DbTag {
    id: number;
    name: string;
    category_id: number | null;
}

export interface DbTagCategory {
    id: number;
    name: string;
    color: string;
    icon: string;
}

export interface DbTagWithCategory extends DbTag {
    category: DbTagCategory | null;
}

export interface DbFolder {
    id: number;
    path: string;
    name: string;
    profile_image_hash: string | null;
    date_added: string;
}

export interface DbFolderMetadata {
    key: string;
    value: string;
    type: "string" | "number" | "date" | "url";
}

export interface FolderNode {
    name: string;
    relativePath: string;
    children: FolderNode[];
}