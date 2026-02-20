export type CategoryId = "dvd" | "bluray" | "collectorBluray" | "hdd";

export interface FieldDefinition {
  key: string;
  label: string;
  aliases?: string[];
  required?: boolean;
  placeholder?: string;
}

export interface CategoryDefinition {
  id: CategoryId;
  label: string;
  sheetName: string;
  fields: FieldDefinition[];
  searchField: string;
  serialPattern?: RegExp;
  serialPatternHint?: string;
}

export type MovieRecord = { id: string } & Record<string, string>;

export type CategoryRecords = Record<CategoryId, MovieRecord[]>;
