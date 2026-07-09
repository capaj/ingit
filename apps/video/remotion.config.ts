import {Config} from '@remotion/cli/config'

// Remotion's loader asks the workspace TypeScript package to parse tsconfig.
// This monorepo intentionally tracks TypeScript 7, whose package surface is
// still changing. Supplying the equivalent raw config keeps the video build
// isolated from that compiler implementation detail.
Config.overrideWebpackConfig((configuration) => {
  const rules = configuration.module?.rules ?? []

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || !('use' in rule) || !Array.isArray(rule.use)) continue
    for (const loader of rule.use) {
      if (!loader || typeof loader !== 'object' || !('loader' in loader)) continue
      if (typeof loader.loader !== 'string' || !loader.loader.includes('esbuild-loader')) continue
      loader.options = {
        ...(typeof loader.options === 'object' && loader.options ? loader.options : {}),
        tsconfigRaw: {
          compilerOptions: {
            jsx: 'react-jsx',
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            allowSyntheticDefaultImports: true,
            esModuleInterop: true,
          },
        },
      }
    }
  }

  return configuration
})
