import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { CartProvider } from "./state/CartContext";
import { CoursesPage } from "./pages/CoursesPage";
import { ReviewPage } from "./pages/ReviewPage";
import { PaymentPage } from "./pages/PaymentPage";

const STEPS = [
  { path: "/", label: "Courses" },
  { path: "/review", label: "Review" },
  { path: "/payment", label: "Payment" },
];

// Three-step journey with free backward navigation until payment is
// submitted. See architecture §3.
export function App() {
  const location = useLocation();
  const currentIndex = STEPS.findIndex((s) => s.path === location.pathname);

  return (
    <CartProvider>
      <div className="shell">
        <header className="shell-header">
          <div className="shell-header-inner">
            <div className="brand-row">
              <span className="brand-mark">Meridian University</span>
              <span className="brand-sub">Student Financial Services</span>
            </div>
            <nav className="breadcrumb" aria-label="Checkout steps">
              {STEPS.map((step, i) => {
                const isCurrent = i === currentIndex;
                return (
                  <span key={step.path} className="breadcrumb-item">
                    {i > 0 && <span className="breadcrumb-sep">—</span>}
                    <NavLink
                      to={step.path}
                      end={step.path === "/"}
                      className={`breadcrumb-link ${isCurrent ? "is-current" : ""}`}
                    >
                      {step.label}
                    </NavLink>
                  </span>
                );
              })}
            </nav>
          </div>
        </header>
        <main className="shell-main">
          <Routes>
            <Route path="/" element={<CoursesPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/payment" element={<PaymentPage />} />
          </Routes>
        </main>
      </div>
    </CartProvider>
  );
}
