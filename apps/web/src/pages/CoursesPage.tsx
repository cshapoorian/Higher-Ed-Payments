import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CourseSection } from "@juspay-takehome/shared";
import { getCourseSections } from "../api";
import { useCart } from "../state/CartContext";

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Flat add/remove course list, no conflict/prerequisite checking — a
// student-information-system concern, out of scope here. See architecture §3.
export function CoursesPage() {
  const [sections, setSections] = useState<CourseSection[]>([]);
  const { selectedSectionIds, toggleSection } = useCart();
  const navigate = useNavigate();

  useEffect(() => {
    getCourseSections().then((res) => setSections(res.courseSections));
  }, []);

  const selected = sections.filter((s) => selectedSectionIds.includes(s.id));
  const totalCredits = selected.reduce((sum, s) => sum + s.credits, 0);
  const totalTuitionCents = selected.reduce((sum, s) => sum + s.tuitionCents, 0);

  return (
    <div>
      <div className="page-head">
        <span className="eyebrow">Step 1 of 3</span>
        <h1>Choose your courses</h1>
        <p>Add or remove sections freely — tuition is priced per credit hour.</p>
      </div>

      {sections.length === 0 ? (
        <div className="loading-state">Loading course sections…</div>
      ) : (
        <ul className="course-list">
          {sections.map((section) => {
            const isSelected = selectedSectionIds.includes(section.id);
            const perCredit = Math.round(section.tuitionCents / section.credits);
            return (
              <li key={section.id}>
                <label className={`card course-card ${isSelected ? "is-selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSection(section.id)}
                  />
                  <span className="course-check" aria-hidden="true">
                    {isSelected ? "✓" : ""}
                  </span>
                  <span className="course-info">
                    <span className="course-code">{section.code}</span>
                    <span className="course-title">{section.title}</span>
                    <span className="course-meta">
                      {section.credits} credit{section.credits === 1 ? "" : "s"} · {formatUsd(perCredit)}/credit
                    </span>
                  </span>
                  <span className="course-price">
                    <strong>{formatUsd(section.tuitionCents)}</strong>
                    <span>tuition</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className="summary-bar">
        <div className="summary-bar-meta">
          {selected.length === 0 ? (
            "No courses selected yet"
          ) : (
            <>
              {selected.length} course{selected.length === 1 ? "" : "s"} · {totalCredits} credit
              {totalCredits === 1 ? "" : "s"}
              <span className="summary-bar-total">{formatUsd(totalTuitionCents)}</span>
            </>
          )}
        </div>
        <button
          className="btn btn-primary"
          disabled={selectedSectionIds.length === 0}
          onClick={() => navigate("/review")}
        >
          Continue to Review
        </button>
      </div>
    </div>
  );
}
