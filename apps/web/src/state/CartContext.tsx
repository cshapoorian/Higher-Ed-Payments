import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Invoice, Order } from "@juspay-takehome/shared";

interface CartState {
  selectedSectionIds: string[];
  toggleSection: (id: string) => void;
  invoice: Invoice | null;
  setInvoice: (invoice: Invoice) => void;
  order: Order | null;
  setOrder: (order: Order) => void;
}

const CartContext = createContext<CartState | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [selectedSectionIds, setSelectedSectionIds] = useState<string[]>([]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [order, setOrder] = useState<Order | null>(null);

  const value = useMemo<CartState>(
    () => ({
      selectedSectionIds,
      toggleSection: (id: string) =>
        setSelectedSectionIds((prev) =>
          prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
        ),
      invoice,
      setInvoice,
      order,
      setOrder,
    }),
    [selectedSectionIds, invoice, order],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
