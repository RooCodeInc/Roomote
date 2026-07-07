import { useEffect, useRef, useState } from 'react';

export function useEditableRows<TRow, TValue>({
  value,
  onChange,
  valueToRows,
  rowsToValue,
  serializeValue,
}: {
  value: TValue;
  onChange: (next: TValue) => void;
  valueToRows: (value: TValue) => TRow[];
  rowsToValue: (rows: TRow[]) => TValue;
  serializeValue: (value: TValue) => string;
}) {
  const serializedValue = serializeValue(value);
  const lastSerializedValueRef = useRef(serializedValue);
  const pendingSerializedValueRef = useRef<string | null>(null);
  const [rows, setRows] = useState<TRow[]>(() => valueToRows(value));

  useEffect(() => {
    if (lastSerializedValueRef.current !== serializedValue) {
      lastSerializedValueRef.current = serializedValue;
      if (pendingSerializedValueRef.current === serializedValue) {
        pendingSerializedValueRef.current = null;
        return;
      }
      setRows(valueToRows(value));
    }
  }, [serializedValue, value, valueToRows]);

  const updateRows = (nextRows: TRow[]) => {
    const normalized = rowsToValue(nextRows);
    setRows(nextRows);
    pendingSerializedValueRef.current = serializeValue(normalized);
    onChange(normalized);
  };

  return { rows, updateRows };
}
