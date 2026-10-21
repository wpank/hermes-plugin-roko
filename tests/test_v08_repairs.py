"""0.8.0 (round v7): roko's repairs to its planner's draft, on the plan sheet (roko 7c3b523a8, gap-0fb7d9).

roko changes a planner's draft before it validates it: a files path the workspace lacks becomes the file of that name
the task reads, a guard in front of a spec's command goes, a regression check gets its step. Those lines were only in
roko's stderr and tracing. roko now writes them into plan.md's "## Repairs" section and the plan writing's result. The
plan sheet, which the plan writing's page shows too, lists them as "roko repaired the draft", in roko's own words.
"""

from __future__ import annotations

from pathlib import Path

from conftest import FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import plansheet, rundata
from hermes_plugin_roko.runtime import Runtime

REPAIRS = [
    "T1: `core/src/envelope.h` became `core/include/undertow/envelope.h` in its files and its text: "
    "`core/src/envelope.h` does not exist, and `core/include/undertow/envelope.h` is the file of that name it reads",
    "T4 step 4: `grep -q … && tools/spec.sh 2 engine 'P2.18*,P2.19*'` became `tools/spec.sh 2 engine "
    "'P2.18*,P2.19*'`, the source's own commands alone",
    "dropped context files that do not exist: `docs/old.md`",
]
PLAN_MD = (
    "# P2.1 · Voice fixes\n\nThe voice's fixes.\n\n## Tasks\n\n- T1: the envelope.\n\n## Repairs\n\n"
    "roko changed the planner's draft before it validated it:\n\n"
    + "".join(f"- {line}\n" for line in REPAIRS)
    + "\n## Notes\n\nNothing else.\n"
)


def test_the_plan_sheet_lists_rokos_repairs_in_its_own_words(tmp_path: Path, fake: FakeRoko) -> None:
    workspace = tmp_path / "ws"
    folder = workspace / "plans" / "p"
    folder.mkdir(parents=True)
    (folder / "plan.md").write_text(PLAN_MD)
    toml = '[meta]\ntitle = "P"\n\n[[task]]\nid = "T1"\ntitle = "t"\n'
    (folder / "tasks.toml").write_text(toml)
    fake.add_plan("p", "P", [{"id": "T1", "title": "t"}])
    fake.plan_sources["p"] = toml
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        sheet = plansheet.plan_sheet(rt, "p")
    finally:
        rt.close()
    assert sheet["repairs"] == REPAIRS
    # The list shows them; the document does not repeat its heading and first line.
    headings = [section["heading"] for section in sheet["doc"]["sections"]]
    assert "Repairs" not in headings and "Notes" in headings


def test_a_repairs_heading_roko_did_not_write_stays_in_the_document() -> None:
    mine = "# P\n\n## Repairs\n\n- fix the roof before winter\n"
    assert plansheet.repairs_in(mine) == []
    assert plansheet.repairs_in("# P\n\nNo repairs here.\n") == []
    # A bullet roko wrapped onto a second line is one repair; a long list keeps its first lines.
    wrapped = (
        "## Repairs\n\nroko changed the planner's draft before it validated it:\n\n- T1: a\n  b\n- T2: c\n"
    )
    assert plansheet.repairs_in(wrapped) == ["T1: a b", "T2: c"]
    many = "## Repairs\n\nroko changed the planner's draft before it validated it:\n\n" + "- x\n" * 50
    assert len(plansheet.repairs_in(many)) == plansheet.MAX_REPAIRS


def test_the_plan_writings_card_carries_its_repairs() -> None:
    summary = {"state": "succeeded", "result": {"slug": "p", "task_count": 1, "repairs": [*REPAIRS, 7, ""]}}
    assert rundata.plan_generation_card("w-1", summary, {})["repairs"] == REPAIRS
    # roko leaves the field out when it changed nothing.
    assert (
        rundata.plan_generation_card("w-2", {"state": "succeeded", "result": {"slug": "p"}}, {})["repairs"]
        == []
    )
