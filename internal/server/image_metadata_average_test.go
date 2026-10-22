package server

// Equivalence test for the jimpCompatibleAverageColor fast paths.
//
// WHY THIS TEST EXISTS, and why it is not circular: the fast paths replace one generic expression,
//
//	color.NRGBAModel.Convert(source.At(x, y)).(color.NRGBA)
//
// with per-image-type pixel access. The risk of that change is not "is it faster" but "does it
// compute the same colour", and the only way to see it is to compare against the expression it
// replaced. `genericJimpAverageColor` below is that expression, kept verbatim, so a mistake in the
// RGBA un-premultiplication, the YCbCr subsampling offsets or the grayscale alpha accounting fails
// here instead of in a rendered UI a year later.
//
// This is a DERIVATION, labelled as one: it proves the optimisation is behaviour-preserving with
// respect to the pre-change code. The VALUE of dominantColor for real images is pinned separately by
// the recorded image-metadata fixtures, which come from the pinned server.
//
// The images below are built to hit the cases where a fast path can silently differ: alpha 0, 128 and
// 255 for RGBA (three different branches of the un-premultiplication), every YCbCr subsampling ratio,
// a non-zero image origin (so a loop that forgot Bounds().Min reads the wrong pixels), and an image
// with one row (where the vertical pass is skipped and the rounding rule changes).

import (
	"fmt"
	"image"
	"image/color"
	"testing"
)

// genericJimpAverageColor is the pre-fast-path implementation, preserved as the reference.
func genericJimpAverageColor(source image.Image) string {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width <= 0 || height <= 0 {
		return "#808080"
	}
	rowColors := make([][4]float32, height)
	for y := 0; y < height; y++ {
		var red, green, blue, alpha, visiblePixels uint64
		for x := 0; x < width; x++ {
			pixel := color.NRGBAModel.Convert(source.At(bounds.Min.X+x, bounds.Min.Y+y)).(color.NRGBA)
			alpha += uint64(pixel.A)
			if pixel.A == 0 {
				continue
			}
			visiblePixels++
			red += uint64(pixel.R)
			green += uint64(pixel.G)
			blue += uint64(pixel.B)
		}
		rowColors[y] = jimpAverageRow(width, red, green, blue, alpha, visiblePixels)
	}
	var red, green, blue float32
	var visibleRows uint64
	for _, row := range rowColors {
		if row[3] == 0 {
			continue
		}
		visibleRows++
		red = float32(red + row[0])
		green = float32(green + row[1])
		blue = float32(blue + row[2])
	}
	if visibleRows == 0 {
		return "#000000"
	}
	round := func(value float32) uint8 {
		if height == 1 {
			return uint8(float64(value))
		}
		return uint8(float64(value)/float64(visibleRows) + 0.5)
	}
	return fmt.Sprintf("#%02x%02x%02x", round(red), round(green), round(blue))
}

func TestJimpAverageColorFastPathsMatchTheGenericExpression(t *testing.T) {
	cases := map[string]image.Image{}
	add := func(name string, source image.Image) { cases[name] = source }
	add("nrgba.alphaMix", buildNRGBA(image.Rect(0, 0, 13, 7)))
	add("nrgba.singleRow", buildNRGBA(image.Rect(0, 0, 9, 1)))
	add("nrgba.offsetOrigin", buildNRGBA(image.Rect(4, 3, 15, 8)))
	add("nrgba.fullyTransparent", buildNRGBAAlpha(image.Rect(0, 0, 6, 4), func(int, int) uint8 { return 0 }))
	add("rgba.alphaMix", buildRGBA(image.Rect(0, 0, 13, 7)))
	add("rgba.singleRow", buildRGBA(image.Rect(0, 0, 9, 1)))
	add("rgba.offsetOrigin", buildRGBA(image.Rect(2, 6, 13, 11)))
	add("rgba.fullyTransparent", buildRGBAAlpha(image.Rect(0, 0, 6, 4), func(int, int) uint8 { return 0 }))
	add("gray.mix", buildGray(image.Rect(0, 0, 13, 7)))
	add("gray.singleRow", buildGray(image.Rect(0, 0, 9, 1)))
	add("gray.offsetOrigin", buildGray(image.Rect(5, 5, 16, 10)))
	for _, ratio := range []image.YCbCrSubsampleRatio{
		image.YCbCrSubsampleRatio444,
		image.YCbCrSubsampleRatio422,
		image.YCbCrSubsampleRatio420,
		image.YCbCrSubsampleRatio440,
	} {
		add(fmt.Sprintf("ycbcr.%v", ratio), buildYCbCr(image.Rect(0, 0, 13, 7), ratio))
	}
	add("ycbcr.444.singleRow", buildYCbCr(image.Rect(0, 0, 9, 1), image.YCbCrSubsampleRatio444))
	add("ycbcr.420.offsetOrigin", buildYCbCr(image.Rect(3, 2, 14, 7), image.YCbCrSubsampleRatio420))
	add("paletted.fallsBackToGeneric", buildPaletted(image.Rect(0, 0, 13, 7)))

	for name, source := range cases {
		want := genericJimpAverageColor(source)
		got := jimpCompatibleAverageColor(source)
		if got != want {
			t.Fatalf("%s: fast path = %s, the generic expression it replaced = %s (%T)", name, got, want, source)
		}
	}
	if len(cases) < 15 {
		t.Fatalf("the equivalence table has only %d images", len(cases))
	}
}

func buildNRGBA(rect image.Rectangle) *image.NRGBA {
	return buildNRGBAAlpha(rect, func(x, y int) uint8 {
		return uint8([]int{0, 128, 255}[x%3])
	})
}

func buildNRGBAAlpha(rect image.Rectangle, alphaAt func(x, y int) uint8) *image.NRGBA {
	result := image.NewNRGBA(rect)
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			result.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 7), G: uint8(y * 11), B: uint8(x * y), A: alphaAt(x, y)})
		}
	}
	return result
}

func buildRGBA(rect image.Rectangle) *image.RGBA {
	return buildRGBAAlpha(rect, func(x, y int) uint8 {
		return uint8([]int{0, 128, 255}[x%3])
	})
}

func buildRGBAAlpha(rect image.Rectangle, alphaAt func(x, y int) uint8) *image.RGBA {
	result := image.NewRGBA(rect)
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			alpha := alphaAt(x, y)
			// Premultiplied: every channel must be <= alpha.
			channel := func(base uint8) uint8 { return uint8(uint16(base) * uint16(alpha) / 255) }
			result.SetRGBA(x, y, color.RGBA{R: channel(uint8(40 + x%100)), G: channel(uint8(90 + y%100)), B: channel(uint8(200 - x%100)), A: alpha})
		}
	}
	return result
}

func buildGray(rect image.Rectangle) *image.Gray {
	result := image.NewGray(rect)
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			result.SetGray(x, y, color.Gray{Y: uint8((x*13 + y*29) % 256)})
		}
	}
	return result
}

func buildYCbCr(rect image.Rectangle, ratio image.YCbCrSubsampleRatio) *image.YCbCr {
	result := image.NewYCbCr(rect, ratio)
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			result.Y[result.YOffset(x, y)] = uint8((x*17 + y*23) % 256)
		}
	}
	for y := rect.Min.Y; y < rect.Max.Y; y += 2 {
		for x := rect.Min.X; x < rect.Max.X; x += 2 {
			offset := result.COffset(x, y)
			if offset < len(result.Cb) {
				result.Cb[offset] = uint8((x*9 + 40) % 256)
				result.Cr[offset] = uint8((y*9 + 200) % 256)
			}
		}
	}
	return result
}

func buildPaletted(rect image.Rectangle) *image.Paletted {
	palette := color.Palette{
		color.NRGBA{R: 10, G: 20, B: 30, A: 255},
		color.NRGBA{R: 200, G: 100, B: 50, A: 128},
		color.NRGBA{R: 0, G: 0, B: 0, A: 0},
	}
	result := image.NewPaletted(rect, palette)
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			result.SetColorIndex(x, y, uint8((x+y)%len(palette)))
		}
	}
	return result
}
