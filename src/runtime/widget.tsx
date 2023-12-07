/** @jsx jsx */
import { React, jsx, type AllWidgetProps, DataSourceComponent, DataSourceManager, DataActionManager, ReactRedux, type IMState, type Immutable, type DataSourcesJson, dataSourceUtils, getAppStore, type WidgetsJson, i18n } from 'jimu-core'
import {
  type MapDataSource,
  DataSourceTypes,
  loadArcGISJSAPIModules,
  JimuMapViewComponent,
  type JimuMapView,
  MapViewManager
} from 'jimu-arcgis'
import { WidgetPlaceholder, DataActionList, Slider } from 'jimu-ui'
import { type IMConfig } from '../config'
import { getStyle } from './lib/style'
import type Action from './actions/action'
import Goto from './actions/goto'
import Label from './actions/label'
import Opacity from './actions/opacity'
import Information from './actions/information'
import defaultMessages from './translations/default'
import layerListIcon from '../../icon.svg'
import { versionManager } from '../version-manager'

export enum LoadStatus {
  Pending = 'Pending',
  Fulfilled = 'Fulfilled',
  Rejected = 'Rejected',
}

export interface WidgetProps extends AllWidgetProps<IMConfig> {
  dataSourcesConfig: Immutable.ImmutableObject<DataSourcesJson>
  appWidgets: Immutable.ImmutableObject<WidgetsJson>
}

export interface WidgetState {
  mapViewWidgetId: string
  jimuMapViewId: string
  mapDataSourceId: string
  loadStatus: LoadStatus
  visibleLayers: any
  currentExpandedLayer: any,
}

export class Widget extends React.PureComponent<
  WidgetProps,
  WidgetState
> {
  public viewFromMapWidget: __esri.MapView | __esri.SceneView
  private dataSource: MapDataSource
  private mapView: __esri.MapView
  private sceneView: __esri.SceneView
  private MapView: typeof __esri.MapView
  private SceneView: typeof __esri.SceneView
  public layerList: __esri.LayerList
  private LayerList: typeof __esri.LayerList
  private layerListActions: Action[]
  private renderPromise: Promise<void>
  private currentUseMapWidgetId: string
  private currentUseDataSourceId: string
  private jimuMapView: JimuMapView
  private readonly mountedOptionListenerSet: Set<any>

  private readonly observer = new MutationObserver((mutations) => {
    const hasMenus = mutations.some(mutation => {
      return (mutation.target as any)?.className === 'esri-layer-list__item-actions-menu-item'
    })

    if (hasMenus) {
      const menus = (this.layerList.container as HTMLElement)?.querySelectorAll('.esri-layer-list__item-actions-menu-item')
      for (const menu of menus) {
        if (this.mountedOptionListenerSet.has(menu)) {
          continue
        }
        if (menu?.lastElementChild.className === 'esri-icon-handle-horizontal') {
          this.mountedOptionListenerSet.add(menu)
          // Add another listener for the options click
          menu.addEventListener('click', () => {
            for (const visibleItem of this.getAllVisibleItems()) {
              const ariaControlsValue: string = menu.attributes['aria-controls'].value
              if (ariaControlsValue.includes(visibleItem.uid)) {
                const mapDS = this.getMapDataSource() as MapDataSource

                this.addSpinToWidget(visibleItem)

                mapDS.createDataSourceByLayer(visibleItem.layer).catch(err => {
                  console.error('create data source by layer error:', err)
                }).finally(() => {
                  // The current expanded layer should be updated anyway
                  this.setState({ currentExpandedLayer: visibleItem.layer })
                  // Mount the data-action-list first, call in the hook is jumped once clicked on the same layer
                  this.mountDataActionList()
                })
                return
              }
            }
          })
        }
      }
    }
  })

  static versionManager = versionManager

  public refs: {
    mapContainer: HTMLInputElement
    layerListContainer: HTMLInputElement
    actionListContainer: HTMLDivElement
    loadingSpinContainer: HTMLDivElement
  }

  constructor(props) {
    super(props)
    this.state = {
      mapViewWidgetId: null,
      mapDataSourceId: null,
      jimuMapViewId: null,
      loadStatus: LoadStatus.Pending,
      visibleLayers: [],
      currentExpandedLayer: null,
    }
    this.renderPromise = Promise.resolve()
    this.registerLayerListActions()
    this.mountedOptionListenerSet = new Set()
  }

  private addSpinToWidget(visibleItem) {
    const dom = document.querySelector(`div[id*="${visibleItem.uid}_actions"]`)
    const classesToReplace = ['data-action-list-wrapper', 'data-action-list-loading', 'invalid-ds-message']

    if (dom.lastElementChild && (dom.lastElementChild?.lastElementChild?.attributes.getNamedItem('title')?.value === '' ||
      classesToReplace.includes(dom.lastElementChild.className))) {
      dom.lastChild.replaceWith(this.refs?.loadingSpinContainer)
    } else {
      // The last child is native action, append the loading-spin
      dom.append(this.refs?.loadingSpinContainer)
    }
  }

  componentDidMount() { }

  componentDidUpdate(prevProps, prevState) {
    if (this.needToPreventRefresh(prevProps)) {
      return
    }

    if ((prevState.visibleLayers !== this.state.visibleLayers) ||
      (prevState.currentExpandedLayer !== this.state.currentExpandedLayer)) {
      // If re-render is caused by the layers change / expanded layer change, DO NOT create the layer-list again
      this.mountDataActionList()
      return
    }

    this.updateRenderer()
  }

  updateRenderer() {
    if (this.props.config.useMapWidget) {
      if (this.state.mapViewWidgetId === this.currentUseMapWidgetId) {
        this.syncRenderer(this.renderPromise)
      }
    } else {
      if (this.state.mapDataSourceId === this.currentUseDataSourceId) {
        this.syncRenderer(this.renderPromise)
      }
    }
  }


  needToPreventRefresh(prevProps) {
    if (this.props.appWidgets !== prevProps.appWidgets) {
      const newTableKeys = Object.keys(this.props.appWidgets || {}).filter(key => this.props.appWidgets[key].uri === 'widgets/common/table/')
      const oldTableKeys = Object.keys(prevProps.appWidgets || {}).filter(key => prevProps.appWidgets[key].uri === 'widgets/common/table/')
      // The number of table widgets is the same
      if (newTableKeys.length === oldTableKeys.length &&
        this.props.appWidgets[this.props.id] === prevProps.appWidgets[this.props.id]) {
        // Table doesn't change AND widget doesn't change
        return true
      }
    }
    return false
  }

  async createView() {
    if (this.props.config.useMapWidget) {
      return await Promise.resolve(this.viewFromMapWidget)
    } else {
      return await this.createViewByDatatSource()
    }
  }

  async createViewByDatatSource() {
    return await this.loadViewModules(this.dataSource).then(async () => {
      if (this.dataSource.type === DataSourceTypes.WebMap) {
        return await new Promise((resolve, reject) => { this.createWebMapView(this.MapView, resolve, reject) }
        )
      } else if (this.dataSource.type === DataSourceTypes.WebScene) {
        return new Promise((resolve, reject) => { this.createSceneView(this.SceneView, resolve, reject) }
        )
      } else {
        return Promise.reject()
      }
    })
  }

  createWebMapView(MapView, resolve, reject) {
    if (this.mapView) {
      this.mapView.map = this.dataSource.map
    } else {
      const mapViewOption: __esri.MapViewProperties = {
        map: this.dataSource.map,
        container: this.refs.mapContainer
      }
      this.mapView = new MapView(mapViewOption)
    }
    this.mapView.when(
      () => {
        resolve(this.mapView)
      },
      (error) => reject(error)
    )
  }

  createSceneView(SceneView, resolve, reject) {
    if (this.sceneView) {
      this.sceneView.map = this.dataSource.map
    } else {
      const mapViewOption: __esri.SceneViewProperties = {
        map: this.dataSource.map,
        container: this.refs.mapContainer
      }
      this.sceneView = new this.SceneView(mapViewOption)
    }

    this.sceneView.when(
      () => {
        resolve(this.sceneView)
      },
      (error) => reject(error)
    )
  }

  destoryView() {
    this.mapView && !this.mapView.destroyed && this.mapView.destroy()
    this.sceneView && !this.sceneView.destroyed && this.sceneView.destroy()
  }

  async loadViewModules(
    dataSource: MapDataSource
  ): Promise<typeof __esri.MapView | typeof __esri.SceneView> {
    if (dataSource.type === DataSourceTypes.WebMap) {
      if (this.MapView) {
        return await Promise.resolve(this.MapView)
      }
      return await loadArcGISJSAPIModules(['esri/views/MapView']).then(
        (modules) => {
          [this.MapView] = modules
          return this.MapView
        }
      )
    } else if (dataSource.type === DataSourceTypes.WebScene) {
      if (this.SceneView) {
        return Promise.resolve(this.SceneView)
      }
      return loadArcGISJSAPIModules(['esri/views/SceneView']).then(
        (modules) => {
          [this.SceneView] = modules
          return this.SceneView
        }
      )
    } else {
      return Promise.reject()
    }
  }

  destoryLayerList() {
    this.layerList && !this.layerList.destroyed && this.layerList.destroy()
  }

  async componentWillUnmount() {
    const customizeLayerOptions = this.props?.config?.customizeLayerOptions?.[this.state.jimuMapViewId]
    const hiddenLayerSet = new Set(customizeLayerOptions?.hiddenJimuLayerViewIds)

    this.observer.disconnect()
    // When delete the widget, ONLY reset the MODIFIED customize listMode of layer instance to 'show'
    if (customizeLayerOptions?.isEnabled) {
      const jimuMapView = MapViewManager.getInstance().getJimuMapViewById(this.state.jimuMapViewId)
      const jimuLayerViews = jimuMapView?.jimuLayerViews || {}

      for (const jimuLayerViewId of Object.keys(jimuLayerViews)) {
        const currentJimuLayerView = await jimuMapView.whenJimuLayerViewLoaded(jimuLayerViewId)
        const currentLayer = currentJimuLayerView.layer

        if (hiddenLayerSet.has(jimuLayerViewId)) {
          currentLayer.listMode = 'show'
        }
      }
    }
  }

  createLayerList(view) {
    let layerListModulePromise
    if (this.LayerList) {
      layerListModulePromise = Promise.resolve()
    } else {
      layerListModulePromise = loadArcGISJSAPIModules([
        'esri/widgets/LayerList'
      ]).then((modules) => {
        [this.LayerList] = modules
      })
    }
    return layerListModulePromise.then(() => {
      const container = document && document.createElement('div')
      container.className = 'jimu-widget'
      this.refs.layerListContainer.appendChild(container)

      this.destoryLayerList()

      // Data action enabled, observe the changes of the DOM
      if (this.props.enableDataAction ?? true) {
        this.mountedOptionListenerSet.clear()
        this.observer.observe(this.refs.layerListContainer, { childList: true, subtree: true })
      }

      const newList = new this.LayerList({
        view: view,
        listItemCreatedFunction: this.defineLayerListActions,
        container: container
      })
      this.layerList = newList

      this.layerList.when(() => {
        // No better way yet, since don't know when all children items are ready
        setTimeout(() => {
          this.setState({ visibleLayers: this.getAllVisibleItems().map(item => item.layer) })
        }, 300)
      })

      this.configLayerList()

      this.layerList.on('trigger-action', (event) => {
        this.onLayerListActionsTriggered(event)
      })
    })
  }

  registerLayerListActions() {
    this.layerListActions = [
      new Goto(
        this,
        this.props.intl.formatMessage({
          id: 'goto',
          defaultMessage: defaultMessages.goto
        })
      ),
      new Label(
        this,
        this.props.intl.formatMessage({
          id: 'showLabels',
          defaultMessage: defaultMessages.showLabels
        }),
        this.props.intl.formatMessage({
          id: 'hideLabels',
          defaultMessage: defaultMessages.hideLabels
        })
      ),
      /*       new Opacity(
              this,
              this.props.intl.formatMessage({
                id: 'increaseTransparency',
                defaultMessage: defaultMessages.increaseTransparency
              }),
              false
            ),
            new Opacity(
              this,
              this.props.intl.formatMessage({
                id: 'decreaseTransparency',
                defaultMessage: defaultMessages.decreaseTransparency
              }),
              true
            ), */
      new Information(
        this,
        this.props.intl.formatMessage({
          id: 'information',
          defaultMessage: defaultMessages.information
        })
      )
    ]
  }

  isCustomizeOptionValid = (usedMapWidgetId): boolean => {
    const appConfig = getAppStore().getState().appConfig
    for (const widgetId of Object.keys(appConfig.widgets)) {
      const widget = appConfig.widgets[widgetId]
      if (
        widget.manifest.name === 'new-map-layers' &&
        widget.id !== this.props.widgetId &&
        widget.useMapWidgetIds?.[0] === usedMapWidgetId
      ) {
        return false
      }
    }
    return true
  }

  hideCustomizedLayers = async () => {
    const customizeLayerOptions = this.props?.config?.customizeLayerOptions?.[this.state.jimuMapViewId]
    // If not using map widget, don't touch layer instances, just return
    if (!this.state.mapViewWidgetId || !customizeLayerOptions?.isEnabled) {
      return
    }

    const jimuMapView = MapViewManager.getInstance().getJimuMapViewById(this.state.jimuMapViewId)
    const jimuLayerViews = jimuMapView?.jimuLayerViews || {}

    const hiddenLayerSet = new Set(customizeLayerOptions?.hiddenJimuLayerViewIds)

    for (const jimuLayerViewId of Object.keys(jimuLayerViews)) {
      const currentJimuLayerView = await jimuMapView.whenJimuLayerViewLoaded(jimuLayerViewId)
      const currentLayer = currentJimuLayerView.layer

      if (customizeLayerOptions?.isEnabled && hiddenLayerSet?.has(jimuLayerViewId)) {
        // When customize valid, only hide the layer when customization enabled & found in the set
        currentLayer.listMode = 'hide'
      } else {
        currentLayer.listMode = 'show'
      }
    }
  }

  getMapDataSource = () => {
    let mapDS = null
    if (this.props.config.useMapWidget) {
      mapDS = DataSourceManager.getInstance().getDataSource(this.jimuMapView?.dataSourceId) as MapDataSource
    } else {
      mapDS = this.dataSource
    }
    return mapDS
  }

  createDataActionList = (layer) => {
    // The map data source might come from a data-source object or from a map widget data-source id

    // Get the newest jimuMapView instance
    this.jimuMapView = MapViewManager.getInstance().getJimuMapViewById(this.state.jimuMapViewId)

    const mapDS = this.getMapDataSource() as MapDataSource
    const featureDS = mapDS?.getDataSourceByLayer(layer)

    const jimuLayerId = dataSourceUtils.getJimuLayerIdByJSAPILayer(layer)

    if (!featureDS) {
      // No valid data-source, create an empty message
      return <div ref={jimuLayerId} key={jimuLayerId} className='invalid-ds-message'>
        {i18n.getIntl().formatMessage({ id: 'noActions' })}
      </div>
    }

    const dataSet = { dataSource: featureDS, records: [], name: featureDS?.getLabel() }

    return (
      <div ref={jimuLayerId} key={jimuLayerId} className="data-action-list-wrapper">
        <DataActionList widgetId={this.props.id} dataSet={dataSet}></DataActionList>
      </div>
    )
  }

  getSupportedDataActions = async (layer) => {
    const mapDS = this.getMapDataSource() as MapDataSource
    const featureDS = mapDS?.getDataSourceByLayer(layer)

    if (!featureDS) {
      return false
    }

    const dataSet = { dataSource: featureDS, records: [], name: featureDS?.getLabel() }
    const actionsPromise = DataActionManager.getInstance().getSupportedActions(this.props.id, dataSet)

    const actions = await actionsPromise || {}
    return actions
  }

  shouldPushEmptyActions = async (item, actionGroups) => {
    // Don't push empty nodes if data action is disabled
    if (!(this.props.enableDataAction ?? true)) {
      return false
    }
    return true
  }

  defineLayerListActions = async (event) => {
    const item = event.item
    const actionGroups = {}
    item.actionsSections = []

    if (this.props.config?.useMapWidget && this.props.config?.enableLegend && item.layer.legendEnabled) {
      item.panel = {
        content: 'legend',
        open: item.layer.visible && this.props.config?.showAllLegend
      }
    }

    this.layerListActions.forEach((actionObj) => {
      if (actionObj.isValid(item)) {
        let actionGroup = actionGroups[actionObj.group]
        if (!actionGroup) {
          actionGroup = []
          actionGroups[actionObj.group] = actionGroup
        }

        actionGroup.push({
          id: actionObj.id,
          title: actionObj.title,
          className: actionObj.className
        })
      }
    })

    if (await this.shouldPushEmptyActions(item, actionGroups)) {
      const EMPTY_ACTION_INDEX = 10
      actionGroups[EMPTY_ACTION_INDEX] = [
        { id: '', title: '', className: '' },
        { id: '', title: '', className: '' }]
    }

    Object.entries(actionGroups)
      .sort((v1, v2) => Number(v1[0]) - Number(v2[0]))
      .forEach(([key, value]) => {
        item.actionsSections.push(value)
      })
  }

  configLayerList() {
    if (!this.props.config.setVisibility || !this.props.config.useMapWidget) {
      // @ts-expect-error
      this.layerList._toggleVisibility = function () { }
    }
  }

  onLayerListActionsTriggered = (event) => {
    const action = event.action
    const item = event.item
    const actionObj = this.layerListActions.find(
      (actionObj) => actionObj.id === action.id
    )
    actionObj.execute(item)
  }

  async renderLayerList() {
    await this.createView()
      .then((view) => {
        return this.createLayerList(view)
      })
      .then(() => {
        this.setState({
          loadStatus: LoadStatus.Fulfilled
        })
      })
      .catch((error) => { console.error(error) })
  }

  syncRenderer(preRenderPromise) {
    this.jimuMapView = MapViewManager.getInstance().getJimuMapViewById(this.state.jimuMapViewId)

    this.renderPromise = new Promise((resolve, reject) => {
      preRenderPromise.then(() => {
        this.renderLayerList()
          .then(() => {
            resolve(null)
            this.hideCustomizedLayers()
          })
          .catch(() => { reject() })
      })
    })
  }

  mountDataActionList() {
    if (!(this.props.enableDataAction ?? true)) {
      return
    }
    if (!this.state.currentExpandedLayer) {
      return
    }

    this.getAllVisibleItems().forEach(async (visibleItem) => {
      const activeJimuLayerId = dataSourceUtils.getJimuLayerIdByJSAPILayer(this.state.currentExpandedLayer)
      const currentJimuLayerId = dataSourceUtils.getJimuLayerIdByJSAPILayer(visibleItem.layer)
      if (activeJimuLayerId !== currentJimuLayerId) {
        return
      }
      const dom = document.querySelector(`div[id*="${visibleItem.uid}_actions"]`)

      this.addSpinToWidget(visibleItem)
      console.log(visibleItem.layer)

      const dataActionsLength = Object.keys(await this.getSupportedDataActions(visibleItem.layer)).length
      // Minus 1 because we always push a fake group
      const nativeActionsLength = visibleItem.actionsSections.length - 1

      // Finish loading, replace / remove the loading spin
      const isLastChildFakeNode = this.refs?.[activeJimuLayerId] && dom?.lastElementChild?.lastElementChild?.attributes.getNamedItem('title')?.value === ''
      const isLastChildLoadingSpin = this.refs?.[activeJimuLayerId] && dom?.lastElementChild?.className === 'data-action-list-loading'



      // When there's a fake node group OR loading-spin
      if (isLastChildFakeNode || isLastChildLoadingSpin) {
        if (nativeActionsLength > 0 && dataActionsLength === 0) {
          // Remove the appended node when no data-action list, but native actions

          dom.lastChild?.remove()
        } else {

          dom.lastChild?.replaceWith(this.refs?.[activeJimuLayerId])
        }
      }

      if (this.props.config.opacity) {
        let sliderContainer = dom.querySelector('.custom-slider-container');

        // If the container doesn't exist, create a new one
        if (!sliderContainer) {
          sliderContainer = document.createElement('div');
          sliderContainer.classList.add('custom-slider-container');

          sliderContainer.style.borderTopStyle = 'solid';
          sliderContainer.style.borderTopColor = 'lightgray';
          sliderContainer.style.borderTopWidth = '2px';
          sliderContainer.style.display = 'flex';
          sliderContainer.style.alignItems = 'center';

          // Create an icon element
          const transparencyIcon = document.createElement('calcite-icon');
          transparencyIcon.setAttribute('icon', 'transparency');
          transparencyIcon.style.marginLeft = '14px';

          // Create a label element for transparency
          const label = document.createElement('label');
          label.classList.add('transparency-label'); // Add any necessary classes for styling
          label.textContent = 'Transparency';
          label.style.fontSize = '12px';
          label.style.marginLeft = '2px';
          label.style.marginRight = '20px';
          label.style.marginTop = '8px';
          // Create an input element for the slider
          const sliderInput = document.createElement('input');
          sliderInput.setAttribute('type', 'range');
          sliderInput.setAttribute('role', 'slider');
          sliderInput.setAttribute('aria-orientation', 'horizontal');
          sliderInput.setAttribute('aria-valuenow', '0');
          sliderInput.setAttribute('value', '0');
          sliderInput.classList.add('jimu-slider'); // Assuming 'jimu-slider' is the appropriate class for styling

          // Implement logic to update layer transparency based on the slider value
          sliderInput.addEventListener('input', (event) => {
            const value = (event.target as HTMLInputElement).value;
            visibleItem.layer.opacity = 1 - Number(value) / 100;
          });

          // Append label and slider to the container
          sliderContainer.appendChild(transparencyIcon);
          sliderContainer.appendChild(label);
          sliderContainer.appendChild(sliderInput);

          // Append the container to the DOM
          //dom.appendChild(sliderContainer);
          dom.insertBefore(sliderContainer, dom.lastChild)
        }
      }

    })

  }

  getAllVisibleItems = () => {
    const allItems = []
    const helper = (item) => {
      allItems.push(item)
      item.children.forEach(child => { helper(child) })
    }

    for (const item of (this.layerList as any)?.visibleItems.items || []) {
      helper(item)
    }
    return allItems
  }

  onActiveViewChange = (jimuMapView: JimuMapView) => {
    const useMapWidget =
      this.props.useMapWidgetIds && this.props.useMapWidgetIds[0]
    if ((jimuMapView && jimuMapView.view) || !useMapWidget) {
      this.viewFromMapWidget = jimuMapView && jimuMapView.view
      this.setState({
        mapViewWidgetId: useMapWidget,
        jimuMapViewId: jimuMapView.id,
        loadStatus: LoadStatus.Pending
      })
    } else {
      this.destoryLayerList()
    }
  }

  onDataSourceCreated = (dataSource: MapDataSource): void => {
    this.dataSource = dataSource
    this.setState({
      mapDataSourceId: dataSource.id,
      loadStatus: LoadStatus.Pending
    })
  }


  // eslint-disable-next-line
  onCreateDataSourceFailed = (error): void => { };



  render() {
    const useMapWidget =
      this.props.useMapWidgetIds && this.props.useMapWidgetIds[0]
    const useDataSource =
      this.props.useDataSources && this.props.useDataSources[0]

    this.currentUseMapWidgetId = useMapWidget
    this.currentUseDataSourceId = useDataSource && useDataSource.dataSourceId

    let dataSourceContent = null
    if (this.props.config.useMapWidget) {
      dataSourceContent = (
        <JimuMapViewComponent
          useMapWidgetId={this.props.useMapWidgetIds?.[0]}
          onActiveViewChange={this.onActiveViewChange}
        />
      )
    } else if (useDataSource) {
      dataSourceContent = (
        <DataSourceComponent
          useDataSource={useDataSource}
          onDataSourceCreated={this.onDataSourceCreated}
          onCreateDataSourceFailed={this.onCreateDataSourceFailed}
        />
      )
    }

    let content = null
    if (this.props.config.useMapWidget ? !useMapWidget : !useDataSource) {
      this.destoryLayerList()
      content = (
        <div className="widget-layerlist">
          <WidgetPlaceholder
            icon={layerListIcon}
            message={this.props.intl.formatMessage({
              id: '_widgetLabel',
              defaultMessage: defaultMessages._widgetLabel
            })}
            widgetId={this.props.id}
          />
        </div>
      )
    } else {
      let loadingContent = null
      if (this.state.loadStatus === LoadStatus.Pending) {
        loadingContent = <div className="jimu-secondary-loading" />
      }

      content = (
        <div className={`widget-layerlist widget-layerlist_${this.props.id}`}>
          {loadingContent}
          <div ref="layerListContainer" />
          <div style={{ position: 'absolute', opacity: 0 }} ref="mapContainer">
            mapContainer
          </div>
          <div style={{ position: 'absolute', display: 'none' }}>
            {dataSourceContent}
          </div>
        </div>
      )
    }

    return (
      <div
        css={getStyle(this.props.theme, this.props.config)}
        className="jimu-widget"
      >
        {content}
        <div key={Math.random()} style={{ height: '0px', overflow: 'hidden' }}>
          {this.state.currentExpandedLayer && this.createDataActionList(this.state.currentExpandedLayer)}
          <div ref='loadingSpinContainer' className='data-action-list-loading' >
            <div className='dot-loading'></div>
          </div>
        </div>
      </div>
    )
  }
}

export default ReactRedux.connect((state: IMState) => {
  const s = state.appStateInBuilder?.appConfig || state.appConfig
  return {
    dataSourcesConfig: s?.dataSources,
    appWidgets: s?.widgets
  }
})(Widget)
