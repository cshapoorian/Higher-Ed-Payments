import { NavLink, Route, Routes } from "react-router-dom";
import { CartProvider } from "./state/CartContext";
import { CoursesPage } from "./pages/CoursesPage";
import { ReviewPage } from "./pages/ReviewPage";
import { PaymentPage } from "./pages/PaymentPage";

// Three-step journey with free backward navigation until payment is
// submitted. See architecture §3.
export function App() {
  return (
    <CartProvider>
      <div className="app">
        <nav className="steps">
          <NavLink to="/" end>
            1. Courses
          </NavLink>
          <NavLink to="/review">2. Review</NavLink>
          <NavLink to="/payment">3. Payment</NavLink>
        </nav>
        <Routes>
          <Route path="/" element={<CoursesPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/payment" element={<PaymentPage />} />
        </Routes>
      </div>
    </CartProvider>
  );
}
