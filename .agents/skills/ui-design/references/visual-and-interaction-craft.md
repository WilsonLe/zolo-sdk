# Visual and interaction craft

Use these checks proportionately. Preserve the project's design language; the goal is coherent hierarchy and useful interaction, not a mandatory aesthetic recipe.

## Direction and substance

For a new surface or substantial redesign, ground the visual direction in facts about the subject and its audience. A material, recognizable product output, local setting, or distinctive workflow can inform composition, imagery, and vocabulary. Explain the connection briefly in the existing task notes. For a public page, consider whether replacing the name with a competitor's would leave every design choice equally plausible; use what is specific to sharpen the result. Familiar controls and conventional layouts remain useful in working interfaces.

Plan public-page sections around what the reader needs to understand, the evidence available, and the next action. Show required details such as actual offerings, dates, location, or price where they answer those questions. Choose section count and order from that content. Carry the direction into later sections and the close, while keeping repeated information easy to scan. Layout variety is useful when the content changes; repeated records benefit from consistency.

Make the first view explain the offering or current work context and expose the next useful action. Judge later views for the same clarity and completeness. When simplification leaves an accidental gap, adjust the grouping, scale, or layout around the useful content. A sparse empty state can be complete; a populated page with missing decision information cannot.

## Copy and imagery

Write concrete headings, labels, and actions using the product's vocabulary. Check important text at its actual rendered width with the intended font loaded. Adjust wording, measure, and scale together to preserve hierarchy and readable wrapping. Content length and localization can require more lines; a fixed headline character count or line limit is not a quality gate. Keep essential constraints and useful explanations next to the decisions they support.

Choose compositions that work with available assets. Inspect images for subject accuracy, crop, legibility, and consistency; preserve the information needed on smaller screens. Prefer real product views or demonstrations when they provide evidence. Use external or generated imagery only when appropriate to the brief, with required rights and credits, and without presenting it as proof of an actual product, person, place, or result. Photography, an interactive demonstration, or decorative motion is optional when it has no user purpose.

Use supplied or verified facts for prices, availability, testimonials, customers, and performance claims. Keep authorized sample content visibly identified in prototypes and name what needs replacement. A missing booking, payment, or save integration needs an honest unavailable state or an authorized real destination; a polished control must not imply a completed operation.

When working from a supplied or accepted mockup, identify which regions need live controls and responsive content, and which require image assets. Keep interface text and controls semantic and usable. Match a material or photograph with an appropriate available asset; explain a necessary substitution instead of silently losing the intended visual character. The mockup guides composition; unsupported claims and unavailable assets still need resolution.

## Hierarchy and layout

Begin with the content order and the action the user should notice. Use alignment, whitespace, type size/weight, and readable contrast to express that order. A heading, status, and action can often share an open layout without a card around each one. Group content when the boundary communicates a relationship or interaction.

For a new visual system, choose a compact token set and reuse it: a legible body style, a few purposeful heading/label styles, spacing steps, neutral surfaces, clear state colors, and restrained emphasis. Use brand accents where they support recognition or priority. No typeface, palette, component library, border radius, or dark/light theme is universally required.

For a named brand, read color, font, and asset definitions from the current project's approved system or supplied brand guide. If those are absent, consult an official source appropriate to the brief and record where the observations came from. Keep observed styling distinct from an approved project rule. Mark unresolved values as assumptions; continue independent layout work without presenting recalled colors or fonts as verified brand facts.

Keep line lengths comfortable for reading. Use tabular numerals and stable alignment when numbers are compared. Provide enough separation for distinct actions without stretching connected content so far apart that its relationship disappears. Differentiate the primary action locally, and avoid styling every control as primary.

## Working interfaces

Use tables for repeated records with shared attributes. Put decision-relevant columns first, allow useful sorting/filtering, and keep row actions predictable. Column controls help when people need different views; hiding all useful columns by default does not. On small screens, choose essential columns, row detail, or a deliberate scroll region according to the comparison task.

Forms need visible labels, clear requirements, actionable errors, and a clear completion state. Place advanced options behind labeled disclosure only when their defaults are safe for the task. Separate exploration from commitment: viewing a candidate's detail should not select, enroll, invite, archive, or publish it.

Before a visual change, identify the affected content, destinations, field names, event bindings, route parameters, and IDs or hooks read by scripts and tests. Edit within the owning components and preserve those contracts unless changing them is authorized. Retain required text and supplied facts; report intentional changes or uncertain existing claims. Afterward, exercise the preserved links, forms, and state transitions as well as inspecting appearance. A cleaner screenshot cannot justify a lost action or altered submission.

For data views, identify the question each metric or chart answers. Derive repeated totals, charts, and lists from the same underlying data and make their scope clear. Name units, time windows, and comparison baselines; reconcile values according to the product's rounding rules. Preserve the distinction between zero, missing, stale, and partially collected data. Use charts when their relationship helps a decision; retain rows and operational controls people need to act.

## Responsive composition

Plan reading order, navigation, image crops, controls, and disclosure for the available width. Keep the important action and context reachable when panes or columns move. Preserve comparison tasks with suitable columns, detail views, or a deliberate table scroll region. Recheck the intermediate layout where columns become cramped, plus long text and realistic data density. Content should remain available when motion is reduced or an optional reveal animation fails.

## State and accessibility

- Make loading, empty, unavailable, error, and completed states distinguishable and truthful.
- Use semantic links for navigation and buttons for actions. Use native controls where practical.
- Preserve keyboard access and visible focus. Use text or accessible names for icon actions; color alone cannot carry meaning.
- Match the disclosure semantics: expanded state for collapsible sections, labeled dialogs with appropriate focus handling, and accessible selected states.
- Keep essential explanations available without hover, and provide touch-friendly controls.
- Check actual rendered contrast and responsive wrapping. A sparse layout does not excuse faint text or clipped content.
- Keep scroll and focus continuity when content opens or updates. Return focus sensibly on dismissal and announce important async outcomes when needed.

## Motion

Use motion to explain a state change, preserve spatial continuity, or acknowledge input. Favor short, interruptible transitions for frequently used controls. Avoid large repeated entrance animations and ornamental movement that competes with the task.

Use easing and duration consistent with the component's movement and the existing system. Support reduced motion with an equivalent understandable state change. Verify interrupted transitions and repeated activation; do not assume a smooth screenshot means a working interaction. Animation values are implementation choices to test, not fixed taste laws.

## Finishing pass

Inspect current rendered captures across the changed surface and its important revealed states. Compare before and after at matching widths and states for a restyle or redesign. First check whether the offering or work context and next action are evident; then inspect content completeness, hierarchy, spacing/alignment, typography, imagery, and accessible states. Look for clipped content, accidental gaps, collisions, and changes that only work above the fold. Remove redundant copy and wrappers; keep explanations that prevent mistakes or clarify the next action. If the surface is deliberately expressive, assess whether the expression helps its purpose rather than automatically flattening it.

For an accepted visual target, compare the implementation at the target's viewport dimensions. Check the dominant elements' size and placement, the gaps between them, image treatment, and what draws attention first. Name and correct the largest unintended difference; explain deliberate departures needed for real copy, accessibility, or responsive behavior. For a redesign, also identify anything that was easier to find, read, or do in the previous version and address regressions within scope.

Record the most consequential observed issues with their screen/state, user impact, and proposed correction. Fix authorized issues in priority order and inspect affected states after the fixes. Keep this within the engineering workflow's review limits and report remaining issues. For a review-only request, stop at findings. A self-assigned aesthetic score or passing source check does not establish frontend quality.

Exercise controls separately from inspecting images. Verify destinations, saved outcomes, keyboard and touch behavior, and reduced-motion states where relevant. Check the supported built preview when available so font loading, asset paths, and production styles are assessed on the candidate people will receive. A screenshot supports appearance at that state; it cannot establish the interaction, backend outcome, or future agent adherence.
