import { CategoryDefinition, CategoryId, CategoryRecords } from "./types";

export const categories: CategoryDefinition[] = [
  {
    id: "dvd",
    label: "DVD目录",
    sheetName: "DVD目录",
    searchField: "title",
    serialPattern: /^\d+$/,
    serialPatternHint: "序号需为整数，例如 12",
    fields: [
      {
        key: "serial",
        label: "序号",
        aliases: ["编号", "no", "id"],
        required: true,
        placeholder: "例如 12"
      },
      {
        key: "title",
        label: "影碟名称",
        aliases: ["电影名称", "名称", "片名"],
        required: true
      },
      {
        key: "remark",
        label: "备注",
        aliases: ["说明", "comments"]
      }
    ]
  },
  {
    id: "bluray",
    label: "蓝光影碟目录",
    sheetName: "蓝光影碟目录",
    searchField: "title",
    serialPattern: /^\d+-\d+$/,
    serialPatternHint: "序号需为 int-int 格式，例如 3-12",
    fields: [
      {
        key: "serial",
        label: "序号",
        aliases: ["编号", "no", "id"],
        required: true,
        placeholder: "例如 3-12"
      },
      {
        key: "title",
        label: "影碟名称",
        aliases: ["电影名称", "名称", "片名"],
        required: true
      },
      {
        key: "remark",
        label: "备注",
        aliases: ["说明", "comments"]
      }
    ]
  },
  {
    id: "collectorBluray",
    label: "精装蓝光影碟目录",
    sheetName: "精装蓝光影碟目录",
    searchField: "title",
    serialPattern: /^\d+$/,
    serialPatternHint: "序号需为整数，例如 8",
    fields: [
      {
        key: "serial",
        label: "序号",
        aliases: ["编号", "no", "id"],
        required: true,
        placeholder: "例如 8"
      },
      {
        key: "title",
        label: "影碟名称",
        aliases: ["电影名称", "名称", "片名"],
        required: true
      },
      {
        key: "remark",
        label: "备注",
        aliases: ["说明", "comments"]
      }
    ]
  },
  {
    id: "hdd",
    label: "硬盘电影目录",
    sheetName: "硬盘电影目录",
    searchField: "title",
    fields: [
      {
        key: "disk",
        label: "所属硬盘",
        aliases: ["硬盘", "硬盘号"],
        required: true
      },
      {
        key: "serial",
        label: "序号",
        aliases: ["编号", "no", "id"],
        required: true
      },
      {
        key: "title",
        label: "电影名称",
        aliases: ["影碟名称", "名称", "片名"],
        required: true
      },
      {
        key: "subtitle",
        label: "字幕",
        aliases: ["字母", "首字母", "letter", "subtitle"]
      },
      {
        key: "genre",
        label: "类型",
        aliases: ["分类", "genre"]
      },
      {
        key: "remark",
        label: "备注",
        aliases: ["说明", "comments"]
      }
    ]
  }
];

export const categoriesById = categories.reduce<Record<CategoryId, CategoryDefinition>>(
  (accumulator, category) => {
    accumulator[category.id] = category;
    return accumulator;
  },
  {
    dvd: categories[0],
    bluray: categories[1],
    collectorBluray: categories[2],
    hdd: categories[3]
  }
);

export function createEmptyRecords(): CategoryRecords {
  return {
    dvd: [],
    bluray: [],
    collectorBluray: [],
    hdd: []
  };
}
