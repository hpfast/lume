import { posix } from "lume/deps/path.ts";
import { getPathAndExtension } from "lume/core/utils/path.ts";
import { merge } from "lume/core/utils/object.ts";
import { contentType } from "lume/deps/media_types.ts";

import type Site from "lume/core/site.ts";

interface SourceFormat {
  width?: number;
  scales: Record<string, number>;
  format: string;
}

interface Source extends SourceFormat {
  paths: string[];
}

export interface Options {
  /** The key name for the transformations definitions */
  name?: string;

  /** The priority order of the formats */
  order?: string[];
}

// Default options
export const defaults: Options = {
  name: "transformImages",
  order: ["avif", "webp", "png", "jpg"],
};

export default function (userOptions?: Options) {
  const options = merge(defaults, userOptions);

  return (site: Site) => {
    const transforms = new Map<string, Source>();

    site.process([".html"], (pages) => {
      for (const page of pages) {
        const { document } = page;

        if (!document) {
          return;
        }

        const basePath = posix.dirname(page.outputPath);
        const images = document.querySelectorAll("img");

        for (const img of Array.from(images)) {
          const transformImages = img.closest("[transform-images]")
            ?.getAttribute(
              "transform-images",
            );

          if (!transformImages) {
            continue;
          }

          if (!img.getAttribute("src")) {
            throw new Error("img element must have a src attribute");
          }


          handleImg(transformImages, img, basePath);
        }
      }

      for (const page of pages) {
        page.document?.querySelectorAll("[transform-images]").forEach(
          (element) => {
            element.removeAttribute("transform-images");
          },
        );
      }
    });


    site.process("*", (pages) => {
      for (const page of pages) {
        const path = page.outputPath;

        for (const { paths, width, scales, format } of transforms.values()) {
          if (!paths.includes(path)) {
            continue;
          }

          const { name } = options;
          const transformImages = page.data[name] = page.data[name]
            ? Array.isArray(page.data[name])
              ? page.data[name]
              : [page.data[name]]
            : [];

          //add an explicit width to 'cover' images (so they stay high enough on narrow screens)
          //'content' images should scale, so height is allowed to scale in proportion to width (default)
          for (const [suffix, scale] of Object.entries(scales)) {
            if (width && path.match(/-cover/)) {
              if (parseInt(width) <= 600) {
                let widthheight = [width, 700];
                transformImages.push({
                  resize: widthheight,
                  suffix,
                  format,
                });
                continue;
              }
            } else {
              transformImages.push({
                resize: width * scale,
                suffix,
                format,
              });
              continue;
            }

            transformImages.push({
              suffix,
              format,
            });
          }
        }
      }
    });

    //unused in my case
    function handlePicture(
      transformImages: string,
      img: Element,
      picture: Element,
      basePath: string,
    ) {
      const src = img.getAttribute("src") as string;
      const sizes = img.getAttribute("sizes");
      const sourceFormats = saveTransform(basePath, src, transformImages);

      sortSources(sourceFormats);
      const last = sourceFormats[sourceFormats.length - 1];

      for (const sourceFormat of sourceFormats) {
        if (sourceFormat === last) {
          editImg(img, src, last, sizes);
          break;
        }
        const source = createSource(
          img.ownerDocument!,
          src,
          sourceFormat,
          sizes,
        );
        picture.insertBefore(source, img);
      }
    }

    function handleImg(
      transformImages: string,
      img: Element,
      basePath: string,
    ) {
      const src = img.getAttribute("src") as string;
      const sizes = img.getAttribute("sizes");
      const sourceFormats = saveTransform(basePath, src, transformImages);

      sortSources(sourceFormats);
      if (sourceFormats.length === 1) {
        editImg(img, src, sourceFormats[0], sizes);
        return;
      }

      // I modified editImg to take the whole sourceFormats array.
      editImg(img, src, sourceFormats, sizes);

    }

    function sortSources(sources: SourceFormat[]) {
      const { order } = options;

      sources.sort((a, b) => {
        const aIndex = order.indexOf(a.format);
        const bIndex = order.indexOf(b.format);

        if (aIndex === -1) {
          return 1;
        }

        if (bIndex === -1) {
          return -1;
        }

        return aIndex - bIndex;
      });
    }

    function saveTransform(
      basePath: string,
      src: string,
      transformImages: string,
    ): SourceFormat[] {
      const path = src.startsWith("/") ? src : posix.join(basePath, src);
      const sizes: string[] = [];
      const formats: string[] = [];

      transformImages.trim().split(/\s+/).forEach((piece) => {
        if (piece.match(/^\d/)) {
          sizes.push(piece);
        } else {
          formats.push(piece);
        }
      });

      const sourceFormats: SourceFormat[] = [];

      // No sizes, only transform to the formats
      if (!sizes.length) {
        for (const format of formats) {
          const key = `:${format}`;
          const sourceFormat = {
            format,
            scales: { "": 1 },
          };
          sourceFormats.push(sourceFormat);

          const transform = transforms.get(key);

          if (transform) {
            if (!transform.paths.includes(path)) {
              transform.paths.push(path);
            }

            Object.assign(transform.scales, sourceFormat.scales);
          } else {
            transforms.set(key, {
              ...sourceFormat,
              paths: [path],
            });
          }
        }

        return sourceFormats;
      }

      for (const size of sizes) {
        const [width, scales] = parseSize(size);

        for (const format of formats) {
          const key = `${width}:${format}`;
          const sourceFormat = {
            width,
            format,
            scales: {} as Record<string, number>,
          };
          sourceFormats.push(sourceFormat);

          for (const scale of scales) {
            const suffix = `-${width}w${scale === 1 ? "" : `@${scale}`}`;
            sourceFormat.scales[suffix] = scale;
          }

          const transform = transforms.get(key);

          if (transform) {
            if (!transform.paths.includes(path)) {
              transform.paths.push(path);
            }

            Object.assign(transform.scales, sourceFormat.scales);
          } else {
            transforms.set(key, {
              ...sourceFormat,
              paths: [path],
            });
          }
        }
      }

      return sourceFormats;
    }
  };
}

function parseSize(size: string): [number, number[]] {
  const match = size.match(/^(\d+)(@([\d.,]+))?$/);

  if (!match) {
    throw new Error(`Invalid size: ${size}`);
  }

  const [, width, , scales] = match;

  // Use a Set to avoid duplicates
  const sizes = new Set<number>([1]);
  scales?.split(",").forEach((size) => sizes.add(parseFloat(size)));

  return [
    parseInt(width),
    [...sizes.values()],
  ];
}

//modifying to create a srcset string with _all_ the specified formats
function createSrcset(
  src: string,
  srcFormats: [SourceFormat],
  sizes?: string | null | undefined,
): string[] {
  const srcset: string[] = [];
  const path = encodeURI(getPathAndExtension(src)[0]);
  for (const fmt of srcFormats) {
    const { scales, format, width } = fmt;

    for (const [suffix, scale] of Object.entries(scales)) {
      const scaleSuffix = sizes && width
        ? ` ${scale * width}w`
        : scale === 1
        ? ""
        : ` ${scale}x`;
      srcset.push(`${path}${suffix}.${format}${scaleSuffix}`);
    }
  };

  return srcset;
}

function createSource(
  document: Document,
  src: string,
  srcFormat: SourceFormat,
  sizes?: string | null | undefined,
) {
  const source = document.createElement("source");
  const srcset = createSrcset(src, srcFormat, sizes);

  source.setAttribute("srcset", srcset.join(", "));
  source.setAttribute("type", contentType(srcFormat.format) || "");

  if (sizes) {
    source.setAttribute("sizes", sizes);
  }

  return source;
}

function editImg(
  img: Element,
  src: string,
  srcFormats: [SourceFormat],
  sizes?: string | null | undefined,
) {
  const srcset = createSrcset(src, srcFormats, sizes);

  if (srcset.length) {
    img.setAttribute("srcset", srcset.join(", "));
  }

  if (sizes) {
    img.setAttribute("sizes", sizes);
  }
}
