import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CourseSection } from "@juspay-takehome/shared";
import { getCourseSections } from "../api";
import { useCart } from "../state/CartContext";

// Flat add/remove course list, no conflict/prerequisite checking — a
// student-information-system concern, out of scope here. See architecture §3.
export function CoursesPage() {
  const [sections, setSections] = useState<CourseSection[]>([]);
  const { selectedSectionIds, toggleSection } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    getCourseSections().then((res) => setSections(res.courseSections));
  }, []);

  return (
    <div className="page">
      <h1>Choose your courses</h1>
      <ul className="section-list">
        {sections.map((section) => (
          <li key={section.id}>
            <label>
              <input
                type="checkbox"
                checked={selectedSectionIds.includes(section.id)}
                onChange={() => toggleSection(section.id)}
              />
              {section.code} — {section.title} ({section.credits} cr) · $
              {(section.tuitionCents / 100).toFixed(2)}
            </label>
          </li>
        ))}
      </ul>
      <button disabled={selectedSectionIds.length === 0} onClick={() => navigate("/review")}>
        Continue to Review
      </button>
    </div>
  );
}
