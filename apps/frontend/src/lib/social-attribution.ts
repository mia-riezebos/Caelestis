import { decodePng } from '@caelestis/shared'

// Rasterized from static/social/osm-attribution.svg for the Worker GIF encoder.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAASCAYAAADyiPTBAAAACXBIWXMAAAsTAAALEwEAmpwYAAAIWUlEQVRoge2Z5W8UaxTG+WP4QHAtWoIWCNAigeIaKC6FECwQIARNseLuXiSBBofiDe4EAsW6Xe/udn23e/Ob5JCXubPQmwsUmQ8nnXn3lSPPec55p1USiUSxKaYPEn+ID6pUtgKmmD5ImIA2QWASQcJkaBMEiT/eB2bL8QsEwZTEjwd0UVGRdfz48YERI0YER44cGRw1alTw4cOHdqO5sVisOCcnx9u4ceNYw4YN423atInu2LGj9EcE6uLFi86uXbtGOIfzFi5c6ON8fissLHQ8e/bM9j3OuXr1quP169faXllZWYGOHTtGotHoF3OGDh2KXwK/CiCLioqsly9fdhr9hv6hUMiyceNGz/bt2yscG2zeu3fvD4nlTwP0u3fvrP379w99+PDBarPZSp4/f25zuVwlgPvOnTv/AvW8efPK+vTpE/r06ZOV97dv31o7d+4cWbt2red7KhsIBCz16tWL37t3T9PB6XSWZGRkRPbs2aM5fNiwYcELFy4YBvS/St++fUM3b9508NyjR49w/fr145cuXXKq4Kldu3a8V69e4coOokhOTo4XSZagJP7SpUt9q1atMpxjJHa7vaRZs2axyrbtfwF60qRJfkC9ZMkS3+zZs8v4O3XqVL/P57PASupcr9drqVGjRjngUsdJgrp168bD4bAFRti8ebNn8ODBIYBfUFCgAQXZuXNnKaAggWT8xo0bjtzcXA9npqenh1esWKEFgPPr1KkTl8RBHj16ZL9796797NmzTkAHEz1+/NjOWs7MzMwMffz40VpYWGjnfMC5YcMGTzwe19a/fPnSlpWVFczIyAhjJ/qePHnShe4k5atXr2ysmTZtmp895dzVq1d7J06cGBBAk/j8ToKptmzZskWzfdCgQZrt165d+2y7Ktu2bSvt1q1bGH2vXLniEGIYO3ZsID09PTJz5swyt9ut+XjWrFllR44ccTN34MCBIex98+aNNTU1NYYcO3bMBZls2rTJg37Xr193kOzYBqCJL/qQtJKkZ86ccaKrSlLEEJuqVatWjq2Mnzt3zsk69t26dWspfiT26MdcqjpJMG7cOE3vCRMmBIqLi0sqFdAwMaVGZR+r1aophYKAWMZhy9TU1KjRPikpKXGcMnfu3LIOHTpEYPkXL17YGMcJeXl5rt69e4cJFMFr3bp1lEQCUAD3wYMHdsALQ9y/f19jZRioVq1a5YCGgMGUjFNOCS5r0Z3zCALgYI/mzZvHnj59avP7/Zbhw4cHYXWeW7ZsGYW9CPaMGTP8gJq9sP38+fNO9gLQJEzTpk1j0naQaKdPn3aJj8aMGROQNougt2rVKirg69SpUwQbaYewHT+ofkJngo9PaHNkTlpaWhRwotvy5cu96C1nE4fS0lILPsjMzAyj16JFi3xIMBi0ZGdn+0kQbHM4HCX4k3EAjc34hGROSUmJ8QyxoKvoxJ63bt1yEJcmTZrEPB6PBf+RMOiIfti+f/9+t8ViKalatWqCpKSCz5kzp2zNmjUaCZHMK1eu9P4SgAY0MgZT8RdH4UgZJ8NxvNE+9LmwB4DGWBmHEU+cOOGiL588ebIfZwpTAwoCrFYCenjAI++A49ChQ25YgOpAYuhbDgBNT80zTu/SpUtEzoFNhgwZEiTYBEjGCTbrjFoOmBU96OFJSnzEegE0TAVA8vLy3NgLwwug2Vt0B5SqLQiJt2/fPre8U4nYS/VrJBIprl69ejl/ATRVjHESGiLQtxzZ2dlahZL1KqAFbAhsfeDAAXcyQKstB+tIGJmTn5+vxQlAQzIyTs+NX0nCZPeunwpoyhwllMDDAJQiQAhzUbbVuTB3zZo1y/WsQ2YDNvpeAnzw4EG3uj+AHDBgQIgzBFAIrAygmSPzR48eHTh16pSL7N+1a1epEbsZAVqSEP0BnnoO++Xn5zvbt28fVcdFTyNAHz9+3EVZXbZsmZdnFdDYAdBgIwINgATQR48e/Ww7F0xAr/e3OgbwqEhilwj+pDpyjgCFdgrGNQL04cOH3UaAVluL6dOn+3fv3q3ZToWScVowPaAXL17sU9kWMgP4ALpFixZf9Nm0gQsWLPAxjm8qFdC0CWQeJZCgUW5xJP2RejESIcgwFszCO+Cmv8Mg3gE0a3mmzFP+ATzAwKHCcLAFIEoG6CdPnti4FAJ6+Q0WINl4hvHpBfWAxrl8eSGgvBNAemDAQMmlJDOOndwZeKbHxHYV0OhOgAAaiaoCGvaEBHim+vAugKYK8Yx/aFtoq1T/8eVhypQp2hwYmBYOW2k93r9/r82ldRImTgbo3NxcD4D9FqBJfMYgKPxCK0RC0bIxLi0KgKYa4yPG8S2+kLYL2+i19YCeP3++T762EIO2bdtGKxXQCK0C5REwAUaYOdknIRwDEBo1aqRdynAAn9PEcABNySf4GEcAJcDsS4D4nRaCNckAzTO9L5c/koLzevbsGSao/LZ+/XpPgwYN4rC0CmgE5iJ4tFH0tAIq9gMQBBPdBCjMp2XiQiWAFl0kOfUMje0kAgmObgCDoKu2q22ACEADZN27dw+jt3yFwGZ6cXRm7e3bt+1fA3RBQYGDVmfdunWerwEasuGsdu3aRaX9ALjoz0UYnyIAmt+oYviMZ+KclpYWYX2/fv1CtH96QLMOnWjraJtoaSod0CpYYaOKbAa7cMHQf6+VHhoAC4urwoUDqajSfH7i5qz/soJ8TVf0ExZVBX1pneTLR0X2MhIqEyyujkkPTYUzsl0VQKVfj60ARu/TZBIOhy0Vmcs5RvYZ+VTvCxJDqloyQQf0lv8R/FH/KdRfCv8m0V8KTUn8/oCmLHK5+BuDyT+nvsVmpiR+L0CbYvog8ZN8YALaBFvxn+SDfwD/pYY2m/hlGAAAAABJRU5ErkJggg=='

/** Keep map attribution visible in every frame, above the pixel artwork. */
export const stampMapAttribution = async (
  frames: readonly Uint8Array[],
  width: number,
  height: number,
) => {
  const label = await decodePng(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)))
  for (const frame of frames) {
    for (let y = 0; y < label.height; y++) {
      for (let x = 0; x < label.width; x++) {
        const targetX = width - label.width + x
        const targetY = height - label.height + y
        if (targetX < 0 || targetY < 0) continue
        const source = (y * label.width + x) * 4
        const target = (targetY * width + targetX) * 4
        const alpha = label.pixels[source + 3] / 255
        for (let c = 0; c < 3; c++)
          frame[target + c] = Math.round(
            label.pixels[source + c] * alpha + frame[target + c] * (1 - alpha),
          )
      }
    }
  }
}
