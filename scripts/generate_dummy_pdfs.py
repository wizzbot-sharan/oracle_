from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf"
OUTPUT.mkdir(parents=True, exist_ok=True)

INK = colors.HexColor("#173F37")
MUTED = colors.HexColor("#52635E")
ACCENT = colors.HexColor("#79A600")
LINE = colors.HexColor("#DCE2DD")


def styles():
    base = getSampleStyleSheet()
    return {
        "name": ParagraphStyle("Name", parent=base["Title"], fontName="Helvetica-Bold", fontSize=22, leading=25, textColor=INK, spaceAfter=3),
        "contact": ParagraphStyle("Contact", parent=base["BodyText"], fontName="Helvetica", fontSize=8.5, leading=11, textColor=MUTED),
        "section": ParagraphStyle("Section", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=10, leading=12, textColor=INK, spaceBefore=10, spaceAfter=5, borderWidth=0, borderPadding=0),
        "role": ParagraphStyle("Role", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=9.5, leading=12, textColor=INK),
        "body": ParagraphStyle("Body", parent=base["BodyText"], fontName="Helvetica", fontSize=8.6, leading=11.5, textColor=colors.HexColor("#26332F"), spaceAfter=3),
        "small": ParagraphStyle("Small", parent=base["BodyText"], fontName="Helvetica", fontSize=8, leading=10.5, textColor=MUTED),
        "letter": ParagraphStyle("Letter", parent=base["BodyText"], fontName="Helvetica", fontSize=10, leading=15, textColor=colors.HexColor("#26332F"), spaceAfter=13, alignment=TA_LEFT),
    }


def rule():
    table = Table([[""]], colWidths=[7.15 * inch], rowHeights=[1])
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), LINE)]))
    return table


def build_resume():
    s = styles()
    path = OUTPUT / "dummy-resume.pdf"
    doc = SimpleDocTemplate(str(path), pagesize=LETTER, rightMargin=0.68 * inch, leftMargin=0.68 * inch, topMargin=0.55 * inch, bottomMargin=0.55 * inch)
    story = [
        Paragraph("Alex Morgan", s["name"]),
        Paragraph("Synthetic Test Candidate | alex.morgan@example.test | +1 555 010 2040 | Columbus, Ohio", s["contact"]),
        Spacer(1, 8), rule(),
        Paragraph("PROFESSIONAL SUMMARY", s["section"]),
        Paragraph("Synthetic software engineering profile created only for testing the ApplyWizard Oracle Recruiting Cloud workflow. Experienced in backend systems, browser automation, data validation, and reliable delivery pipelines.", s["body"]),
        Paragraph("SKILLS", s["section"]),
        Paragraph("Python, JavaScript, TypeScript, React, Node.js, PostgreSQL, Playwright, REST integrations, CI/CD, test automation", s["body"]),
        Paragraph("EXPERIENCE", s["section"]),
        Paragraph("Software Engineer | Example Systems Lab | January 2023 - Present", s["role"]),
        Paragraph("- Built deterministic browser workflows with field-level validation and recovery checkpoints.<br/>- Developed normalized data models for dynamic forms and reusable user answers.<br/>- Added automated tests and operational logging for high-volume background jobs.", s["body"]),
        Spacer(1, 4),
        Paragraph("Junior Software Engineer | Sample Technology Group | June 2020 - December 2022", s["role"]),
        Paragraph("- Implemented internal React tools backed by Node.js and PostgreSQL.<br/>- Improved data-quality checks for imported customer records.<br/>- Documented production procedures and supported release verification.", s["body"]),
        Paragraph("EDUCATION", s["section"]),
        Paragraph("Bachelor of Science in Computer Science | Example State University | 2020", s["role"]),
        Paragraph("GPA: 3.7 / 4.0", s["small"]),
        Paragraph("PROJECTS", s["section"]),
        Paragraph("Dynamic Form Mapper - Prototype that discovers accessible form controls, records conditional visibility, and renders normalized form definitions for review.", s["body"]),
        Spacer(1, 9), rule(), Spacer(1, 6),
        Paragraph("TEST DATA NOTICE: This document contains fictional information and must not be submitted as a real candidate resume.", s["small"]),
    ]
    doc.build(story)
    return path


def build_cover_letter():
    s = styles()
    path = OUTPUT / "dummy-cover-letter.pdf"
    doc = SimpleDocTemplate(str(path), pagesize=LETTER, rightMargin=0.8 * inch, leftMargin=0.8 * inch, topMargin=0.7 * inch, bottomMargin=0.7 * inch)
    story = [
        Paragraph("Alex Morgan", s["name"]),
        Paragraph("Synthetic Test Candidate | alex.morgan@example.test | +1 555 010 2040", s["contact"]),
        Spacer(1, 10), rule(), Spacer(1, 20),
        Paragraph("November 2, 2026", s["letter"]),
        Paragraph("Hiring Team<br/>Example Employer", s["letter"]),
        Paragraph("Dear Hiring Team,", s["letter"]),
        Paragraph("I am writing to express interest in the advertised software engineering position. My fictional test profile combines backend development, browser automation, structured data modeling, and careful verification of user-facing workflows.", s["letter"]),
        Paragraph("In the sample experience represented by this document, I developed reliable automation systems, React dashboards, and PostgreSQL-backed tools. I focused on safe execution, auditable state transitions, and explicit human review before irreversible actions.", s["letter"]),
        Paragraph("I would welcome the opportunity to discuss how these skills could support your engineering team. Thank you for your consideration.", s["letter"]),
        Paragraph("Sincerely,<br/><br/><b>Alex Morgan</b>", s["letter"]),
        Spacer(1, 45), rule(), Spacer(1, 7),
        Paragraph("TEST DATA NOTICE: This fictional cover letter exists only for application-workflow testing and must not be used for a real candidate.", s["small"]),
    ]
    doc.build(story)
    return path


if __name__ == "__main__":
    for generated in (build_resume(), build_cover_letter()):
        print(generated)
