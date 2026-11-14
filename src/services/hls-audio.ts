/** Select an ordinary original/stereo rendition without hiding alternatives. */
export function preferHlsAudioLanguage(content: string, language?: string): string {
    if (!language) return content
    const aliases: Record<string, string> = { fra: 'fr', fre: 'fr', eng: 'en' }
    const normalize = (value: string) => {
        const base = value.toLowerCase().split('-')[0]
        return aliases[base] ?? base
    }
    const wanted = normalize(language)
    const lines = content.split('\n')
    const groups = new Map<string, Array<{ index: number; attributes: Record<string, string> }>>()
    for (const [index, line] of lines.entries()) {
        if (!/^#EXT-X-MEDIA:/i.test(line)) continue
        const attributes: Record<string, string> = {}
        for (const match of line.slice(line.indexOf(':') + 1).matchAll(/(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,\r]*)/gi)) attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '')
        if (attributes.TYPE !== 'AUDIO' || !attributes['GROUP-ID']) continue
        const group = groups.get(attributes['GROUP-ID']) ?? []
        group.push({ index, attributes })
        groups.set(attributes['GROUP-ID'], group)
    }
    for (const group of groups.values()) {
        const candidates = group.filter(
            ({ attributes: a }) => normalize(a.LANGUAGE ?? '') === wanted && !/audio[ -]?description|describes[ -]?video/i.test(`${a.NAME ?? ''} ${a.CHARACTERISTICS ?? ''}`)
        )
        const score = (a: Record<string, string>) => (/\boriginal\b/i.test(a.NAME ?? '') ? 100 : 0) + (a.CHANNELS === '2' || /\bstereo\b/i.test(a.NAME ?? '') ? 10 : 0) + (a.DEFAULT === 'YES' ? 1 : 0)
        const selected = candidates.sort((a, b) => score(b.attributes) - score(a.attributes))[0]
        if (!selected) continue
        for (const item of group) {
            let line = lines[item.index].replace(/\r$/, '')
            for (const name of ['DEFAULT', 'AUTOSELECT']) {
                const value = item.index === selected.index ? 'YES' : 'NO'
                const pattern = new RegExp(`,${name}=(?:YES|NO)`, 'i')
                line = pattern.test(line) ? line.replace(pattern, `,${name}=${value}`) : `${line},${name}=${value}`
            }
            lines[item.index] = line + (lines[item.index].endsWith('\r') ? '\r' : '')
        }
    }
    return lines.join('\n')
}
