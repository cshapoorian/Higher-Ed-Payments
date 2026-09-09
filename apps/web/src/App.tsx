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
            <ol className="stepper">
              {STEPS.map((step, i) => {
                const isCurrent = i === currentIndex;
                const isDone = currentIndex >= 0 && i < currentIndex;
                return (
                  <li key={step.path}>
                    <NavLink
                      to={step.path}
                      end={step.path === "/"}
                      className={`step-link ${isCurrent ? "is-current" : ""} ${isDone ? "is-done" : ""}`}
                    >
                      <span className="step-index">{isDone ? "✓" : i + 1}</span>
                      {step.label}
                    </NavLink>
                    {i < STEPS.length - 1 && <span className="step-connector" />}
                  </li>
                );
              })}
            </ol>
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
