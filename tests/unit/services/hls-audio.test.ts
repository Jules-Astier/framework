import { describe, expect, it } from 'vitest'
import { preferHlsAudioLanguage } from '../../../src/services/hls-audio.js'
const line = (name: string, language: string, extra = '', group = 'audio') => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${group}",NAME="${name}",LANGUAGE="${language}",DEFAULT=NO,AUTOSELECT=YES,URI="${name.replace(/ /g, '-')}.m3u8"${extra}`
const rows = ['#EXTM3U', line('English original', 'en').replace('DEFAULT=NO', 'DEFAULT=YES'), line('French Audio Description stereo', 'fr'), line('French [Original] 5.1', 'fr', ',CHANNELS="6"'), line('French [Original] stereo', 'fr', ',CHANNELS="2"')]
describe('preferred HLS audio language', () => {
    it('selects French original stereo instead of English or audio description', () => {
        const output = preferHlsAudioLanguage(rows.join('\n'), 'fr').split('\n')
        expect(output[4]).toContain('DEFAULT=YES,AUTOSELECT=YES')
        for (const index of [1, 2, 3]) expect(output[index]).toContain('DEFAULT=NO,AUTOSELECT=NO')
        expect(output).toHaveLength(rows.length)
        expect(output[3]).toContain('URI="French-[Original]-5.1.m3u8"')
    })
    it('does not change playlists without a preference or matching language', () => {
        expect(preferHlsAudioLanguage(rows.join('\n'))).toBe(rows.join('\n'))
        expect(preferHlsAudioLanguage(rows.join('\n'), 'ja')).toBe(rows.join('\n'))
    })
    it('does not choose audio description as fallback or alter subtitles', () => {
        const subtitle = '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="fr",DEFAULT=YES,URI="fr.vtt"'
        const input = ['#EXTM3U', line('French AD', 'fr', ',CHARACTERISTICS="public.accessibility.describes-video"'), subtitle].join('\n')
        expect(preferHlsAudioLanguage(input, 'fr')).toBe(input)
    })
    it('normalizes ISO language aliases and selects independently in audio groups', () => {
        const input = ['#EXTM3U', line('French original', 'fra', '', 'aac'), line('French original', 'fr-FR', '', 'ac3')].join('\n')
        expect(preferHlsAudioLanguage(input, 'fr').match(/DEFAULT=YES/g)).toHaveLength(2)
    })
    it('prefers original audio over a stereo track that is not original', () => {
        const input = ['#EXTM3U', line('French dub stereo', 'fr'), line('French [Original] 5.1', 'fr')].join('\n')
        expect(preferHlsAudioLanguage(input, 'fr').split('\n')[2]).toContain('DEFAULT=YES')
    })
    it('preserves CRLF and supports names containing commas', () => {
        const input = ['#EXTM3U', line('French, Original stereo', 'fr')].join('\r\n')+'\r\n'
        const output = preferHlsAudioLanguage(input, 'fr')
        expect(output).toContain('NAME="French, Original stereo"')
        expect(output.split('\r\n')).toHaveLength(3)
        expect(output).toContain('DEFAULT=YES')
    })
})
