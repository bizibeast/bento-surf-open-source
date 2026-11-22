import { BENNY_SKILLS, bennySkillInput, savedBennySkill } from "@/lib/benny-skills";
import type { BrainItem, BrainItemInput } from "@/lib/content-brain";
import { ContentDocument } from "./ContentDocument";

export function BennySkills({
  items,
  onSave,
}: {
  items: BrainItem[];
  onSave: (item: BrainItemInput) => void | Promise<void>;
}) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Ready-to-use workflows for Benny and connected agents, including Claude. Open a skill to
        customize its instructions. Claude can discover these through Bento MCP.
      </p>
      {BENNY_SKILLS.map((skill) => {
        const prior = savedBennySkill(items, skill.id);
        return (
          <details key={skill.id} className="rounded-xl border border-border p-4">
            <summary className="cursor-pointer font-medium">{skill.title}</summary>
            <ContentDocument
              label={skill.title}
              value={prior?.content ?? skill.instructions}
              allowEmpty
              onSave={(content) => onSave(bennySkillInput(skill, content, prior))}
            />
          </details>
        );
      })}
    </div>
  );
}
