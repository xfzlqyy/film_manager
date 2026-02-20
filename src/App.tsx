import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { categories, categoriesById, createEmptyRecords } from "./config";
import { buildSearchIndex, createWorkbookBlob, parseWorkbook, sortCategoryRecords } from "./xls";
import { CategoryId, CategoryRecords, MovieRecord } from "./types";

const API_DATA_URL = "/api/data.xls";
const STATIC_DATA_URL = "/data.xls";

type WritableHandle = {
  name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<WritableHandle[]>;
};

const DEFAULT_CATEGORY: CategoryId = "dvd";

function createRecordId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function parseIntegerSerial(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return Number(normalized);
}

function parseBluraySerial(value: string): { a: number; b: number } | null {
  const normalized = value.trim();
  const matched = normalized.match(/^(\d+)-(\d+)$/);
  if (!matched) {
    return null;
  }
  return { a: Number(matched[1]), b: Number(matched[2]) };
}

function parseChineseDiskNumber(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    return Number(normalized);
  }

  const digitMap: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  const unitMap: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000
  };

  let total = 0;
  let section = 0;
  let digit = 0;
  let hasValidToken = false;

  for (const char of normalized) {
    if (char in digitMap) {
      digit = digitMap[char];
      hasValidToken = true;
      continue;
    }

    const unit = unitMap[char];
    if (!unit) {
      return null;
    }
    hasValidToken = true;

    if (unit === 10000) {
      section = (section + (digit || 0)) * unit;
      total += section;
      section = 0;
      digit = 0;
      continue;
    }

    section += (digit || 1) * unit;
    digit = 0;
  }

  const result = total + section + digit;
  if (!hasValidToken || Number.isNaN(result)) {
    return null;
  }
  return result;
}

function parseDiskOrder(diskName: string): number | null {
  const normalized = diskName.trim();
  if (!normalized) {
    return null;
  }

  const numeric = normalized.match(/(\d+)/);
  if (numeric) {
    return Number(numeric[1]);
  }

  const suffix = normalized.replace(/^硬盘/u, "").trim();
  return parseChineseDiskNumber(suffix);
}

function getHighestDiskName(records: MovieRecord[]): string {
  let bestDisk = "";
  let bestOrder = -1;

  records.forEach((record) => {
    const disk = (record.disk ?? "").trim();
    if (!disk) {
      return;
    }
    const order = parseDiskOrder(disk);
    if (order !== null && order > bestOrder) {
      bestOrder = order;
      bestDisk = disk;
      return;
    }
    if (order === null && !bestDisk) {
      bestDisk = disk;
    }
  });

  return bestDisk;
}

function getNextIntegerSerial(records: MovieRecord[]): string {
  const maxSerial = records.reduce((currentMax, record) => {
    const serialValue = parseIntegerSerial(record.serial ?? "");
    if (serialValue === null) {
      return currentMax;
    }
    return Math.max(currentMax, serialValue);
  }, 0);
  return String(maxSerial + 1);
}

function getNextBluraySerial(records: MovieRecord[]): string {
  let maxA = 1;
  let maxB = 0;

  records.forEach((record) => {
    const parsed = parseBluraySerial(record.serial ?? "");
    if (!parsed) {
      return;
    }
    if (parsed.a > maxA || (parsed.a === maxA && parsed.b > maxB)) {
      maxA = parsed.a;
      maxB = parsed.b;
    }
  });

  if (maxB >= 510) {
    return `${maxA + 1}-1`;
  }
  if (maxB === 0) {
    return "1-1";
  }
  return `${maxA}-${maxB + 1}`;
}

function getNextHddSerial(records: MovieRecord[], diskValue: string): string {
  const targetDisk = diskValue.trim();
  if (!targetDisk) {
    return "";
  }

  const maxSerial = records.reduce((currentMax, record) => {
    if ((record.disk ?? "").trim() !== targetDisk) {
      return currentMax;
    }
    const serialValue = parseIntegerSerial(record.serial ?? "");
    if (serialValue === null) {
      return currentMax;
    }
    return Math.max(currentMax, serialValue);
  }, 0);

  return String(maxSerial + 1);
}

function computeAutoSerial(
  categoryId: CategoryId,
  categoryRecords: MovieRecord[],
  formValues: Record<string, string>
): string {
  if (categoryId === "bluray") {
    return getNextBluraySerial(categoryRecords);
  }
  if (categoryId === "hdd") {
    return getNextHddSerial(categoryRecords, formValues.disk ?? "");
  }
  return getNextIntegerSerial(categoryRecords);
}

function App() {
  const [records, setRecords] = useState(createEmptyRecords);
  const [activeCategory, setActiveCategory] = useState<CategoryId>(DEFAULT_CATEGORY);
  const [searchValue, setSearchValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [fileHandle, setFileHandle] = useState<WritableHandle | null>(null);
  const autoSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const currentCategory = categoriesById[activeCategory];
  const categoryRecords = records[activeCategory];

  const filteredRecords = useMemo(() => {
    const keyword = searchValue.trim().toLowerCase().replace(/。/g, ".");
    if (!keyword) {
      return categoryRecords;
    }
    if (activeCategory === "hdd") {
      return categoryRecords.filter((record) => {
        const searchText = `${(record.disk ?? "").trim()}.${(record.serial ?? "").trim()}.${(record.title ?? "").trim()}`
          .toLowerCase()
          .replace(/。/g, ".");
        return searchText.includes(keyword);
      });
    }
    return categoryRecords.filter((record) => buildSearchIndex(record, activeCategory).includes(keyword));
  }, [activeCategory, categoryRecords, searchValue]);

  function resetForm(nextCategory: CategoryId) {
    const defaultValues: Record<string, string> = {};
    categoriesById[nextCategory].fields.forEach((field) => {
      defaultValues[field.key] = "";
    });

    if (nextCategory === "hdd") {
      const highestDisk = getHighestDiskName(records.hdd);
      defaultValues.disk = highestDisk;
      defaultValues.subtitle = "外挂";
      defaultValues.genre = "mkv";
      defaultValues.serial = getNextHddSerial(records.hdd, highestDisk);
    }

    setFormValues(defaultValues);
  }

  function handleCategorySwitch(nextCategory: CategoryId) {
    setActiveCategory(nextCategory);
    setSearchValue("");
    setIsFormOpen(false);
    setEditingId(null);
    resetForm(nextCategory);
  }

  async function loadFromArrayBuffer(buffer: ArrayBuffer, sourceLabel: string) {
    try {
      const parsed = parseWorkbook(buffer);
      setRecords(parsed);
      setErrorMessage("");
      setStatusMessage(`已加载 ${sourceLabel}`);
    } catch (error) {
      console.error(error);
      setErrorMessage(`读取 ${sourceLabel} 失败，请检查文件结构。`);
    }
  }

  async function loadDefaultFile() {
    setIsLoading(true);
    setFileHandle(null);
    try {
      const isElectronRuntime = navigator.userAgent.includes("Electron");
      if (isElectronRuntime && !window.filmManagerApi) {
        throw new Error("Electron bridge is unavailable. Please restart app.");
      }

      if (window.filmManagerApi) {
        const result = await window.filmManagerApi.loadData();
        if (result.ok && result.dataBase64) {
          await loadFromArrayBuffer(base64ToArrayBuffer(result.dataBase64), result.path ?? "data.xls");
          setStatusMessage(`已加载 ${result.path ?? "data.xls"}`);
          return;
        }
        throw new Error(result.error ?? "Electron failed to load data.xls");
      }

      const apiResponse = await fetch(API_DATA_URL, { cache: "no-store" });
      if (apiResponse.ok) {
        await loadFromArrayBuffer(await apiResponse.arrayBuffer(), "data.xls（API）");
        return;
      }
      throw new Error(`API HTTP ${apiResponse.status}`);
    } catch (apiError) {
      console.warn(apiError);
      try {
        const staticResponse = await fetch(STATIC_DATA_URL, { cache: "no-store" });
        if (!staticResponse.ok) {
          throw new Error(`HTTP ${staticResponse.status}`);
        }
        await loadFromArrayBuffer(await staticResponse.arrayBuffer(), "public/data.xls");
      } catch (staticError) {
        console.error(staticError);
        setRecords(createEmptyRecords());
        setErrorMessage("未能读取 data.xls/public/data.xls，当前已使用空数据。");
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function saveByApi(blob: Blob): Promise<boolean> {
    try {
      const response = await fetch(API_DATA_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.ms-excel"
        },
        body: blob
      });
      return response.ok;
    } catch (error) {
      console.warn(error);
      return false;
    }
  }

  async function saveByElectron(blob: Blob): Promise<FilmLoadResult | null> {
    if (!window.filmManagerApi) {
      return null;
    }

    const payload = await blobToBase64(blob);
    return window.filmManagerApi.saveData(payload);
  }

  async function persistRecords(
    nextRecords: CategoryRecords,
    options: {
      auto: boolean;
      successMessage: string;
      fallbackErrorMessage: string;
    }
  ): Promise<boolean> {
    if (!options.auto) {
      setIsSaving(true);
    }
    setErrorMessage("");

    try {
      const blob = createWorkbookBlob(nextRecords);
      const savedByElectron = await saveByElectron(blob);
      if (savedByElectron) {
        if (savedByElectron.ok) {
          if (savedByElectron.warning) {
            setStatusMessage(
              `${options.successMessage} 已写入 ${savedByElectron.path ?? "data.xls"}，但发生回退：${savedByElectron.warning}`
            );
          } else {
            setStatusMessage(`${options.successMessage} 已持久化到 ${savedByElectron.path ?? "data.xls"}`);
          }
          return true;
        }
        setErrorMessage(savedByElectron.error ?? "Electron 写入 data.xls 失败。");
        return false;
      }

      const savedByApi = await saveByApi(blob);
      if (savedByApi) {
        setStatusMessage(`${options.successMessage} 已持久化到 data.xls 和 public/data.xls`);
        return true;
      }

      if (fileHandle) {
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        setStatusMessage(`${options.successMessage} 已同步写回 ${fileHandle.name}`);
        return true;
      }

      setErrorMessage(options.fallbackErrorMessage);
      return false;
    } catch (error) {
      console.error(error);
      setErrorMessage(options.fallbackErrorMessage);
      return false;
    } finally {
      if (!options.auto) {
        setIsSaving(false);
      }
    }
  }

  function enqueueAutoSave(nextRecords: CategoryRecords, actionLabel: string) {
    autoSaveQueueRef.current = autoSaveQueueRef.current
      .then(async () => {
        await persistRecords(nextRecords, {
          auto: true,
          successMessage: `${actionLabel}，自动保存成功。`,
          fallbackErrorMessage: `${actionLabel}后自动保存失败，请检查写入路径权限。`
        });
      })
      .catch((error) => {
        console.error("[autosave] queue failed", error);
      });
  }

  useEffect(() => {
    void loadDefaultFile();
    resetForm(DEFAULT_CATEGORY);
  }, []);

  useEffect(() => {
    if (!isFormOpen || editingId) {
      return;
    }
    const nextSerial = computeAutoSerial(activeCategory, categoryRecords, formValues);
    setFormValues((previous) => {
      if ((previous.serial ?? "") === nextSerial) {
        return previous;
      }
      return {
        ...previous,
        serial: nextSerial
      };
    });
  }, [activeCategory, categoryRecords, editingId, formValues.disk, isFormOpen]);

  function openCreateForm() {
    setEditingId(null);
    resetForm(activeCategory);
    setIsFormOpen(true);
  }

  function openEditForm(record: MovieRecord) {
    const nextValues: Record<string, string> = {};
    currentCategory.fields.forEach((field) => {
      nextValues[field.key] = record[field.key] ?? "";
    });
    setFormValues(nextValues);
    setEditingId(record.id);
    setIsFormOpen(true);
  }

  function validateForm(): string | null {
    for (const field of currentCategory.fields) {
      const value = (formValues[field.key] ?? "").trim();
      if (field.required && value === "") {
        return `${field.label} 不能为空`;
      }
    }

    if (currentCategory.serialPattern) {
      const serialValue = (formValues.serial ?? "").trim();
      if (serialValue && !currentCategory.serialPattern.test(serialValue)) {
        return currentCategory.serialPatternHint ?? "序号格式不正确";
      }
    }

    return null;
  }

  function handleFieldChange(fieldKey: string, event: ChangeEvent<HTMLInputElement>) {
    if (fieldKey === "serial" && !editingId) {
      return;
    }
    const nextValue = event.target.value;
    setFormValues((previous) => ({
      ...previous,
      [fieldKey]: nextValue
    }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    const nextRecord: MovieRecord = { id: editingId ?? createRecordId() };
    currentCategory.fields.forEach((field) => {
      nextRecord[field.key] = (formValues[field.key] ?? "").trim();
    });

    const current = records[activeCategory];
    const nextCategoryRecords = editingId
      ? current.map((record) => (record.id === editingId ? nextRecord : record))
      : [...current, nextRecord];
    const sortedCategoryRecords = sortCategoryRecords(activeCategory, nextCategoryRecords);
    const nextAllRecords: CategoryRecords = {
      ...records,
      [activeCategory]: sortedCategoryRecords
    };
    setRecords(nextAllRecords);

    setErrorMessage("");
    if (editingId) {
      setStatusMessage("修改成功，正在自动保存...");
      enqueueAutoSave(nextAllRecords, "修改完成");
      setIsFormOpen(false);
      setEditingId(null);
      resetForm(activeCategory);
      return;
    }

    setStatusMessage("新增成功，正在自动保存... 可继续新增，点击取消可关闭输入区域。");
    enqueueAutoSave(nextAllRecords, "新增完成");
    const preservedValues: Record<string, string> = {};
    currentCategory.fields.forEach((field) => {
      preservedValues[field.key] = nextRecord[field.key] ?? "";
    });
    setFormValues(preservedValues);
  }

  function handleDelete(record: MovieRecord) {
    const title = (record.title ?? "").trim();
    const confirmed = window.confirm(title ? `确认删除「${title}」吗？` : "确认删除这条记录吗？");
    if (!confirmed) {
      return;
    }

    const nextAllRecords: CategoryRecords = {
      ...records,
      [activeCategory]: sortCategoryRecords(
        activeCategory,
        records[activeCategory].filter((current) => current.id !== record.id)
      )
    };
    setRecords(nextAllRecords);
    setStatusMessage("删除成功，正在自动保存...");
    enqueueAutoSave(nextAllRecords, "删除完成");
  }

  async function handleSave() {
    await persistRecords(records, {
      auto: false,
      successMessage: "手动保存成功。",
      fallbackErrorMessage: "保存 data.xls 失败，请检查写入路径权限。"
    });
  }

  function handleExport() {
    const blob = createWorkbookBlob(records);
    downloadBlob(blob, "data.xls");
    setStatusMessage("已导出 data.xls");
  }

  async function handlePickFile() {
    if (window.filmManagerApi) {
      try {
        const result = await window.filmManagerApi.pickDataFile();
        if (result.canceled) {
          return;
        }
        if (result.ok && result.dataBase64) {
          await loadFromArrayBuffer(base64ToArrayBuffer(result.dataBase64), result.path ?? "selected data.xls");
          setStatusMessage(`已切换数据文件：${result.path ?? "selected data.xls"}`);
          return;
        }
        setErrorMessage(result.error ?? "选择本地 data.xls 失败。");
      } catch (error) {
        console.error(error);
        setErrorMessage("选择本地 data.xls 失败。");
      }
      return;
    }

    const picker = (window as PickerWindow).showOpenFilePicker;
    if (!picker) {
      setErrorMessage("当前浏览器不支持直接写回文件，请使用“导出 data.xls”方式。");
      return;
    }

    try {
      const handles = await picker({
        multiple: false,
        types: [
          {
            description: "Excel 97-2003",
            accept: {
              "application/vnd.ms-excel": [".xls"]
            }
          }
        ]
      });

      if (handles.length === 0) {
        return;
      }

      const selectedHandle = handles[0];
      const file = await selectedHandle.getFile();
      const buffer = await file.arrayBuffer();
      await loadFromArrayBuffer(buffer, file.name);
      setFileHandle(selectedHandle);
    } catch (error) {
      console.error(error);
      setErrorMessage("选择本地 data.xls 失败。");
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Film Manager</h1>
          <p>维护 data.xls 中的电影目录，支持增删改查并持久化写回文件。</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={loadDefaultFile}>
            重新加载 data.xls
          </button>
          <button type="button" onClick={handlePickFile}>
            选择本地 data.xls（可直接写回）
          </button>
          <button type="button" className="primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "保存中..." : "保存到 data.xls"}
          </button>
          <button type="button" onClick={handleExport}>
            导出 data.xls
          </button>
        </div>
      </header>

      {errorMessage ? <div className="alert error">{errorMessage}</div> : null}
      {statusMessage ? <div className="alert success">{statusMessage}</div> : null}
      {isLoading ? <div className="alert">正在加载数据...</div> : null}

      <section className="category-tabs">
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            className={category.id === activeCategory ? "active" : ""}
            onClick={() => handleCategorySwitch(category.id)}
          >
            {category.label}
          </button>
        ))}
      </section>

      <section className="toolbar">
        <input
          type="search"
          value={searchValue}
          onChange={(event) => setSearchValue(event.target.value)}
          placeholder={
            activeCategory === "hdd"
              ? "按 所属硬盘.序号.电影名 查找，例如 硬盘一.12.盗梦空间"
              : `按 ${currentCategory.fields.find((field) => field.key === currentCategory.searchField)?.label ?? "名称"} 等关键字查找`
          }
        />
        <button type="button" className="primary" onClick={openCreateForm}>
          新增记录
        </button>
      </section>

      {isFormOpen ? (
        <section className="form-panel">
          <h2>{editingId ? "编辑记录" : "新增记录"}</h2>
          <form onSubmit={handleSubmit}>
            {currentCategory.fields.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  value={formValues[field.key] ?? ""}
                  onChange={(event) => handleFieldChange(field.key, event)}
                  placeholder={field.placeholder}
                  readOnly={field.key === "serial" && !editingId}
                />
              </label>
            ))}
            <div className="form-actions">
              <button type="submit" className="primary">
                {editingId ? "保存修改" : "确认新增"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsFormOpen(false);
                  setEditingId(null);
                  resetForm(activeCategory);
                }}
              >
                取消
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="table-wrapper">
        <table>
          <thead>
            <tr>
              {currentCategory.fields.map((field) => (
                <th key={field.key}>{field.label}</th>
              ))}
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredRecords.map((record) => (
              <tr key={record.id}>
                {currentCategory.fields.map((field) => (
                  <td key={field.key}>{record[field.key]}</td>
                ))}
                <td className="actions">
                  <button type="button" onClick={() => openEditForm(record)}>
                    编辑
                  </button>
                  <button type="button" onClick={() => handleDelete(record)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {filteredRecords.length === 0 ? (
              <tr>
                <td colSpan={currentCategory.fields.length + 1} className="empty">
                  没有匹配记录
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default App;
