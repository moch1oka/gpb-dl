/**
 * Strict TypeScript type declarations for Google Play Books API payloads.
 */

export interface GoogleBookMetadata {
  title?: string;
  volume_title?: string;
  authors?: string | string[];
  author?: string;
  creator?: string;
  pub_date?: string;
  pubDate?: string;
  date?: string;
  publication_date?: string;
  publisher?: string;
  language?: string;
  num_pages?: number;
  preview?: string;
}

export interface GoogleBookSegmentManifest {
  label: string;
  title?: string;
  order: number;
  link?: string;
  start?: string;
  num_pages?: number;
  not_viewable?: boolean;
  resource?: { url?: string; mime_type?: string }[];
  fixed_layout_version?: number;
  text_properties?: {
    fixed_layout_version?: number;
    fixed_layout_info?: {
      viewport?: { width: string | number; height: string | number };
    };
  };
}

export interface GoogleBookPageManifest {
  pid: string;
  src?: string;
  order: number;
}

export interface GoogleBookTocEntry {
  label: string;
  depth?: number;
  page_index?: number;
  segment_index?: number;
  reading_position?: string;
  order?: number;
}

export interface GoogleBookManifest {
  volume_id?: string;
  title?: string;
  author?: string;
  language?: string;
  is_right_to_left?: boolean;
  available_mode?: number[]; // 1 = "Original pages" (page images), 2 = "Flowing text" (segments)
  preferred_mode?: number;
  metadata: GoogleBookMetadata;
  segment?: GoogleBookSegmentManifest[];
  page?: GoogleBookPageManifest[];
  toc_entry?: GoogleBookTocEntry[];
}

export interface GoogleBookSegment {
  content?: string;
  style?: string;
  page?: GoogleBookPageManifest[];
}
